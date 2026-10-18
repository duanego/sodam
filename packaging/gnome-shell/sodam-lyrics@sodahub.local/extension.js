//! SodaM 桌面歌词：把当前歌曲嵌进 GNOME 顶栏（对应汽水音乐的任务栏歌词）。
//!
//! 数据来自两处：
//! - MPRIS（`org.mpris.MediaPlayer2.com.sodahub.SodaM`）：封面、歌名、播放状态、传输控制
//! - SodaM 的 D-Bus 接口（`org.sodahub.SodaM.Lyrics`）：当前行、收藏状态
//!
//! 扩展运行在 gnome-shell 进程内，画的是 Clutter actor，所以嵌进顶栏后自然随
//! 顶栏出现/消失，也不会遮挡窗口。只在 SodaM 运行时显示，点击文字区会唤起主窗口。

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_NAME = 'org.mpris.MediaPlayer2.com.sodahub.SodaM';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_IFACE = 'org.mpris.MediaPlayer2.Player';
const LYRICS_NAME = 'org.sodahub.SodaM';
const LYRICS_PATH = '/org/sodahub/SodaM/Lyrics';
const LYRICS_IFACE = 'org.sodahub.SodaM.Lyrics';

export default class SodamLyricsExtension extends Extension {
    enable() {
        this._state = {
            title: '',
            lyric: '',
            artUrl: '',
            playing: false,
            liked: false,
            hasLyrics: false,
            barVisible: true,
        };
        this._sodaMRunning = false;
        this._mpris = null;
        this._lyrics = null;
        this._mprisSignals = [];
        this._lyricsSignals = [];

        this._buildIndicator();

        // SodaM 不在运行时整个 pill 隐藏；启动后重新建代理，避免首次 init 失败
        // 之后永远读不到数据（这是「bar 显示的歌和实际播放不一致」的原因）。
        this._ownerWatcher = Gio.bus_watch_name(
            Gio.BusType.SESSION, MPRIS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._onSodaMPresent(), () => this._onSodaMAbsent());
    }

    disable() {
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        this._drag = null;
        if (this._ownerWatcher) {
            Gio.bus_unwatch_name(this._ownerWatcher);
            this._ownerWatcher = null;
        }
        this._dropProxies();
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ── 顶栏 pill ───────────────────────────────────────────────────────────

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'SodaM 桌面歌词', true);
        this._indicator.add_style_class_name('sodam-lyrics-indicator');
        this._indicator.hide();

        const pill = new St.BoxLayout({
            style_class: 'sodam-lyrics-pill',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        // 封面 + 歌名 · 歌词：整块可点，唤起主窗口。
        this._info = new St.BoxLayout({
            style_class: 'sodam-lyrics-info',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: true,
            track_hover: true,
        });
        this._cover = new St.Icon({
            style_class: 'sodam-lyrics-cover',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = new St.Label({
            style_class: 'sodam-lyrics-title',
            text: 'SodaM',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lyricLabel = new St.Label({
            style_class: 'sodam-lyrics-line',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._info.add_child(this._cover);
        this._info.add_child(this._titleLabel);
        this._info.add_child(this._lyricLabel);
        // 单击唤起主窗口；按住拖动则跟随指针，松手按离哪边近贴哪边。
        this._info.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._beginDrag(event.get_coords()[0]);
            return Clutter.EVENT_STOP;
        });

        this._prevButton = this._buildButton('media-skip-backward-symbolic',
            () => this._callMpris('Previous'));
        this._playButton = this._buildButton('media-playback-start-symbolic',
            () => this._callMpris('PlayPause'));
        this._nextButton = this._buildButton('media-skip-forward-symbolic',
            () => this._callMpris('Next'));
        this._likeButton = this._buildButton('emblem-favorite-symbolic',
            () => this._callLyrics('ToggleLiked'));

        pill.add_child(this._info);
        pill.add_child(this._prevButton);
        pill.add_child(this._playButton);
        pill.add_child(this._nextButton);
        pill.add_child(this._likeButton);
        this._indicator.add_child(pill);

        Main.panel.addToStatusArea('sodam-lyrics', this._indicator, 1, 'left');
    }

    _buildButton(iconName, onClick) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            style_class: 'sodam-lyrics-button-icon',
        });
        const button = new St.Button({
            style_class: 'sodam-lyrics-button',
            child: icon,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    // ── 拖动吸附 ────────────────────────────────────────────────────────────

    _beginDrag(startX) {
        this._drag = {startX, moved: false, translation: 0};
        this._captureId = global.stage.connect('captured-event', (stage, event) => {
            if (!this._drag)
                return Clutter.EVENT_PROPAGATE;
            const type = event.type();
            if (type === Clutter.EventType.MOTION) {
                const dx = event.get_coords()[0] - this._drag.startX;
                if (Math.abs(dx) > 6) {
                    this._drag.moved = true;
                    this._drag.translation = dx;
                    this._indicator.translation_x = dx;
                }
                return this._drag.moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                global.stage.disconnect(this._captureId);
                this._captureId = 0;
                const drag = this._drag;
                this._drag = null;
                this._indicator.translation_x = 0;
                if (drag.moved)
                    this._snap(drag.translation);
                else
                    this._openSodaM();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /// 松手后按距离屏幕左右边决定贴哪一侧的顶栏区域。
    _snap(translation) {
        const monitor = Main.layoutManager.primaryMonitor;
        const [baseX] = this._indicator.get_transformed_position();
        const centerX = baseX + translation + this._indicator.width / 2;
        const toRight = centerX > monitor.x + monitor.width / 2;
        const parent = this._indicator.get_parent();
        if (parent)
            parent.remove_child(this._indicator);
        const panel = Main.panel;
        if (toRight)
            panel._rightBox.insert_child_at_index(this._indicator, 0);
        else
            panel._leftBox.insert_child_at_index(this._indicator, 1);
    }

    _openSodaM() {
        const app = Shell.AppSystem.get_default().lookup_app('sodam.desktop');
        if (app)
            app.activate();
    }

    // ── 生命周期与 D-Bus ────────────────────────────────────────────────────

    _onSodaMPresent() {
        this._sodaMRunning = true;
        this._indicator.show();
        this._dropProxies();
        this._initMpris();
        this._initLyrics();
    }

    _onSodaMAbsent() {
        this._sodaMRunning = false;
        this._indicator.hide();
        this._dropProxies();
    }

    _dropProxies() {
        this._mpris = null;
        this._lyrics = null;
        this._mprisSignals.length = 0;
        this._lyricsSignals.length = 0;
    }

    _initMpris() {
        this._mpris = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: MPRIS_NAME,
            g_object_path: MPRIS_PATH,
            g_interface_name: MPRIS_IFACE,
            g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
        });
        this._mpris.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
            if (this._mpris !== proxy)
                return;
            try {
                proxy.init_finish(result);
            } catch (_e) {
                this._mpris = null;
                return;
            }
            this._mprisSignals.push(
                proxy.connect('g-properties-changed', () => this._syncMpris()));
            this._syncMpris();
        });
    }

    _initLyrics() {
        this._lyrics = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: LYRICS_NAME,
            g_object_path: LYRICS_PATH,
            g_interface_name: LYRICS_IFACE,
            g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
        });
        this._lyrics.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
            if (this._lyrics !== proxy)
                return;
            try {
                proxy.init_finish(result);
            } catch (_e) {
                this._lyrics = null;
                return;
            }
            this._lyricsSignals.push(
                proxy.connect('g-properties-changed', () => this._syncLyrics()));
            this._syncLyrics();
        });
    }

    _callMpris(method) {
        if (!this._mpris)
            return;
        this._mpris.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _callLyrics(method) {
        if (!this._lyrics)
            return;
        this._lyrics.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _syncMpris() {
        if (!this._mpris)
            return;
        const metadata = this._mpris.get_cached_property('Metadata');
        if (metadata) {
            const values = metadata.deep_unpack();
            this._state.title = values['xesam:title']?.deep_unpack() ?? '';
            this._state.artUrl = values['mpris:artUrl']?.deep_unpack() ?? '';
        }
        const status = this._mpris.get_cached_property('PlaybackStatus');
        this._state.playing = status?.deep_unpack() === 'Playing';
        this._render();
    }

    _syncLyrics() {
        if (!this._lyrics)
            return;
        this._state.lyric =
            this._lyrics.get_cached_property('CurrentLine')?.deep_unpack() ?? '';
        this._state.hasLyrics =
            this._lyrics.get_cached_property('HasLyrics')?.deep_unpack() ?? false;
        this._state.liked =
            this._lyrics.get_cached_property('Liked')?.deep_unpack() ?? false;
        this._state.barVisible =
            this._lyrics.get_cached_property('BarVisible')?.deep_unpack() ?? true;
        this._render();
    }

    _render() {
        if (!this._indicator)
            return;
        // 顶栏 pill 只在 SodaM 运行且标题栏开关打开时出现。
        // 没有曲目（或 SodaM 停播）时不占顶栏：MPRIS 已清空元数据。
        this._indicator.visible = this._sodaMRunning && this._state.barVisible &&
            this._state.title !== '';
        this._titleLabel.text = this._state.title || 'SodaM';
        this._lyricLabel.text = this._state.lyric ||
            (this._state.hasLyrics ? '' : '没有可用歌词');

        if (this._state.artUrl) {
            try {
                const file = Gio.File.new_for_uri(this._state.artUrl);
                this._cover.gicon = new Gio.FileIcon({file});
            } catch (_e) {
                this._cover.gicon = null;
            }
        }

        this._playButton.child.icon_name = this._state.playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._likeButton?.child.set_style_class_name(
            this._state.liked ? 'sodam-lyrics-liked' : '');
    }
}
