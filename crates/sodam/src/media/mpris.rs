//! Linux 的 MPRIS（`org.mpris.MediaPlayer2`），通过 `mpris-server` 接入。
//!
//! 注册之后 `playerctl`、GNOME/KDE 的媒体挂件、以及合成器里绑的 `XF86Audio*`
//! 都能控制播放（Hyprland 默认配置就是把媒体键交给 playerctl）。
//!
//! `mpris-server` 的 `Player` 是 `!Send` 的，所以它留在 gpui 的任务里（主线程），
//! 应用侧的每次发布只是往 channel 里排一条更新，按顺序应用。

use std::ffi::c_void;
use std::sync::mpsc::Sender;

use anyhow::Result;
use futures_lite::future;
use gpui::{App, Task};
use mpris_server::{Metadata, PlaybackStatus, Player, Time, TrackId};
use tokio::sync::mpsc;

use super::{Command, NowPlaying, BUS_NAME, DESKTOP_ENTRY, DISPLAY_NAME};

/// 发布到 MPRIS 上的一次变更，按发送顺序应用。
enum Update {
    Metadata(Metadata),
    Playback(PlaybackStatus, Time),
}

/// 桌面歌词扩展读取的 D-Bus 接口。
///
/// MPRIS 只承载播放元数据，没有歌词字段，所以当前歌词行单独走一个接口；
/// 扩展同时读 MPRIS（封面、歌名、传输控制）和这里（歌词、收藏状态）。
const LYRICS_BUS: &str = "org.sodahub.SodaM";
const LYRICS_PATH: &str = "/org/sodahub/SodaM/Lyrics";

/// 公开给桌面歌词扩展的歌词状态。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LyricsState {
    pub current: String,
    pub next: String,
    pub has_lyrics: bool,
    pub liked: bool,
    /// 标题栏开关控制：桌面歌词条是否显示。
    pub visible: bool,
}

struct LyricsInterface {
    state: std::sync::Arc<std::sync::Mutex<LyricsState>>,
    /// 桌面歌词扩展的按钮命令走回应用的媒体命令通道。
    commands: Sender<Command>,
}

#[zbus::interface(name = "org.sodahub.SodaM.Lyrics")]
impl LyricsInterface {
    /// 当前正在唱的一句。
    #[zbus(property)]
    fn current_line(&self) -> String {
        self.state.lock().map(|s| s.current.clone()).unwrap_or_default()
    }

    /// 下一句，用于提前淡入；没有就是空串。
    #[zbus(property)]
    fn next_line(&self) -> String {
        self.state.lock().map(|s| s.next.clone()).unwrap_or_default()
    }

    /// 当前曲目是否有歌词（区分「加载中」与「没有歌词」）。
    #[zbus(property)]
    fn has_lyrics(&self) -> bool {
        self.state.lock().map(|s| s.has_lyrics).unwrap_or(false)
    }

    /// 当前曲目是否已收藏。
    #[zbus(property)]
    fn liked(&self) -> bool {
        self.state.lock().map(|s| s.liked).unwrap_or(false)
    }

    /// 桌面歌词条是否显示（由 SodaM 标题栏的开关控制）。
    #[zbus(property)]
    fn bar_visible(&self) -> bool {
        self.state.lock().map(|s| s.visible).unwrap_or(true)
    }

    /// 设置桌面歌词条是否显示；扩展或标题栏开关都可以调。
    fn set_bar_visible(&self, visible: bool) {
        self.commands.send(Command::SetBarVisible(visible)).ok();
    }

    /// 切换当前曲目的收藏状态（桌面歌词条的心形按钮）。
    fn toggle_liked(&self) {
        self.commands.send(Command::ToggleLike).ok();
    }
}

/// 把歌词状态发布到 D-Bus 的句柄；更新走 channel，由后台任务落到属性上。
struct LyricsPublisher {
    updates: mpsc::UnboundedSender<LyricsState>,
    /// 持有任务：丢掉它等于关掉接口。
    _task: Task<()>,
}

impl LyricsPublisher {
    fn new(cx: &mut App, commands: Sender<Command>) -> Self {
        let (updates, mut receiver) = mpsc::unbounded_channel::<LyricsState>();
        let state = std::sync::Arc::new(std::sync::Mutex::new(LyricsState::default()));
        let interface_state = state.clone();
        let _task = cx.spawn(async move |_| {
            let connection = zbus::connection::Builder::session()
                .and_then(|builder| builder.name(LYRICS_BUS))
                .and_then(|builder| {
                    builder.serve_at(
                        LYRICS_PATH,
                        LyricsInterface { state: interface_state, commands: commands.clone() },
                    )
                });
            let connection = match connection {
                Ok(builder) => match builder.build().await {
                    Ok(connection) => connection,
                    Err(error) => {
                        eprintln!("[lyrics] 无法注册桌面歌词接口：{error}");
                        return;
                    }
                },
                Err(error) => {
                    eprintln!("[lyrics] 无法注册桌面歌词接口：{error}");
                    return;
                }
            };
            let Ok(interface) = connection
                .object_server()
                .interface::<_, LyricsInterface>(LYRICS_PATH)
                .await
            else {
                eprintln!("[lyrics] 无法取得桌面歌词接口引用");
                return;
            };
            while let Some(next) = receiver.recv().await {
                {
                    let Ok(mut current) = state.lock() else { continue };
                    if *current == next {
                        continue;
                    }
                    *current = next;
                }
                let emitter = interface.signal_emitter();
                let interface_ref = interface.get().await;
                let _ = interface_ref.current_line_changed(emitter).await;
                let _ = interface_ref.next_line_changed(emitter).await;
                let _ = interface_ref.has_lyrics_changed(emitter).await;
                let _ = interface_ref.liked_changed(emitter).await;
                let _ = interface_ref.bar_visible_changed(emitter).await;
            }
        });
        Self { updates, _task }
    }

    fn publish(&self, state: LyricsState) {
        self.updates.send(state).ok();
    }
}

pub struct Controls {
    updates: mpsc::UnboundedSender<Update>,
    /// 桌面歌词扩展的独立 D-Bus 接口。
    lyrics: LyricsPublisher,
    /// 持有服务任务：丢掉它等于关掉 MPRIS。
    _server: Task<()>,
}

impl Controls {
    /// 起后台任务去抢总线名。抢不到只记日志，之后每次发布都变成空操作。
    pub fn new(
        _hwnd: Option<*mut c_void>,
        commands: Sender<Command>,
        cx: &mut App,
    ) -> Result<Self> {
        let (updates, mut receiver) = mpsc::unbounded_channel();
        let lyrics_commands = commands.clone();
        let _server = cx.spawn(async move |_| {
            let player = match build(commands).await {
                Ok(player) => player,
                Err(error) => {
                    eprintln!("[media] 无法注册 MPRIS：{error}");
                    return;
                }
            };
            let apply = async {
                while let Some(update) = receiver.recv().await {
                    if let Err(error) = apply(&player, update).await {
                        eprintln!("[media] MPRIS 发布失败：{error}");
                    }
                }
            };
            // 两个 future 都要一直跑：`run()` 服务请求，`apply` 应用应用侧的状态。
            future::zip(player.run(), apply).await;
        });
        Ok(Self {
            updates,
            lyrics: LyricsPublisher::new(cx, lyrics_commands),
            _server,
        })
    }

    /// 发布曲目元数据（只在曲目或封面变化时调用）。
    pub fn publish_metadata(&mut self, now: &NowPlaying) {
        let metadata = if now.has_track() {
            let mut metadata = Metadata::builder()
                .trackid(track_id(&now.track_id))
                .title(now.title.clone())
                .artist(vec![now.artist.clone()])
                .album(now.album.clone())
                .length(time(now.duration_seconds))
                .build();
            metadata.set_art_url(now.cover_url().as_deref());
            metadata
        } else {
            Metadata::builder().trackid(TrackId::NO_TRACK).build()
        };
        self.send(Update::Metadata(metadata));
    }

    /// 发布播放状态与进度（播放/暂停切换、切曲、拖动时调用）。
    pub fn publish_playback(&mut self, now: &NowPlaying) {
        let status = match (now.has_track(), now.playing) {
            (false, _) => PlaybackStatus::Stopped,
            (true, true) => PlaybackStatus::Playing,
            (true, false) => PlaybackStatus::Paused,
        };
        self.send(Update::Playback(status, time(now.position_seconds)));
    }

    /// 发布当前歌词行；扩展靠它更新桌面歌词。
    pub fn publish_lyrics(&mut self, state: LyricsState) {
        self.lyrics.publish(state);
    }

    fn send(&self, update: Update) {
        self.updates.send(update).ok();
    }
}

/// 注册 `org.mpris.MediaPlayer2.sodam`，把播放器接受的方法转成 `Command`。
async fn build(commands: Sender<Command>) -> mpris_server::zbus::Result<Player> {
    let player = Player::builder(BUS_NAME)
        .identity(DISPLAY_NAME)
        .desktop_entry(DESKTOP_ENTRY)
        .can_play(true)
        .can_pause(true)
        .can_go_next(true)
        .can_go_previous(true)
        .can_control(true)
        .build()
        .await?;

    let send = move |command| {
        commands.send(command).ok();
    };
    player.connect_play({
        let send = send.clone();
        move |_| send(Command::Play)
    });
    player.connect_pause({
        let send = send.clone();
        move |_| send(Command::Pause)
    });
    player.connect_stop({
        let send = send.clone();
        move |_| send(Command::Pause)
    });
    player.connect_play_pause({
        let send = send.clone();
        move |_| send(Command::Toggle)
    });
    player.connect_next({
        let send = send.clone();
        move |_| send(Command::Next)
    });
    player.connect_previous(move |_| send(Command::Previous));
    Ok(player)
}

async fn apply(player: &Player, update: Update) -> mpris_server::zbus::Result<()> {
    match update {
        Update::Metadata(metadata) => player.set_metadata(metadata).await,
        Update::Playback(status, at) => {
            player.set_position(at);
            player.set_playback_status(status).await
        }
    }
}

/// MPRIS 需要每首曲目一个对象路径，用来把「跳转到哪个曲目」的请求对上号。
/// 服务端的 id 里有路径不允许的字符，所以路径放它的哈希。
fn track_id(id: &str) -> TrackId {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    TrackId::try_from(format!("/app/sodam/track/t{:016x}", hasher.finish()))
        .unwrap_or(TrackId::NO_TRACK)
}

fn time(seconds: f64) -> Time {
    Time::from_micros((seconds.max(0.0) * 1_000_000.0) as i64)
}
