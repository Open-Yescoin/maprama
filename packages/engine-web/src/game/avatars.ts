/**
 * World-model avatars: character portraits drawn as **3D objects** in the
 * scene instead of as DOM elements in `mpr-overlay`.
 *
 * A marker avatar is a DOM view positioned every frame from a projected point,
 * which means it cannot be occluded by the world, does not turn with the
 * camera, and has to be re-decorated by the host after each render. An avatar
 * here is a textured billboard parented to the engine's dynamic group: it is
 * placed once in world units, scales with zoom and is depth-sorted by three.js
 * like every other object.
 *
 * See `setWorldAvatars` / `removeWorldAvatars`.
 *
 * @module
 */

import gsap from 'gsap';
import { CanvasTexture, Group, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader, type Texture } from 'three';
import type { WorldAvatarFaceSpec, WorldAvatarSpec } from '@open-yescoin/maprama-protocol';
import type { SceneApi } from '../scene-api.js';
import { resolveMarkerPoint } from '../labels/markers.js';
import type { AnchorContext } from '../labels/anchor.js';
import { groundYFor } from '../game/follower.js';

/** Default avatar edge length in world units (a storey is about 3). */
export const DEFAULT_AVATAR_METERS = 2.4;

interface Avatar {
  /** Creation order, for a stable entrance stagger. */
  sequence: number;
  spec: WorldAvatarSpec;
  /** The disc: portrait, or the fallback label. */
  sprite: Sprite;
  material: SpriteMaterial;
  texture: Texture;
  /**
   * The frame: border ring, accent and pointer, in its own texture and always
   * added after the disc so it composites on top of it.
   */
  frame: Sprite;
  frameMaterial: SpriteMaterial;
  /** Cache key of the texture currently applied (URI or fallback letter). */
  key: string;
  /** True while the disc fallback is shown because the portrait could not load. */
  usingFallback: boolean;
  /** Inputs the current disc texture was built from (portrait, label, accent, pointer). */
  discKey: string;
  /** Anchor height before the bob is applied, in world units. */
  baseY: number;
  /** Bob amplitude in world units (0 when the avatar does not float). */
  amplitude: number;
  /**
   * Last size written to the disc/frame pair, per axis.
   *
   * The frame loop used to re-apply the resting size to both sprites every
   * frame even though it only changes when the spec size changes (or while an
   * entrance/breathe owns it); comparing against these skips those no-op
   * writes. Two fields rather than one: a spec can set width and height
   * independently, so a single scale would miss a height-only change.
   */
  appliedW: number;
  appliedH: number;
  /**
   * Entrance state. `pendingDelayMs` is set when the layer arrives and is
   * resolved into an absolute `startedAt` on the next frame; `startedAt` stays
   * `null` when no entrance is pending or the entrance has settled.
   */
  motion: { startedAt: number | null; pendingDelayMs: number | null; durationMs: number; entered: boolean };
  /** Optional attention halo behind the disc. */
  halo: Sprite | null;
  haloMaterial: SpriteMaterial | null;
  /** Running entrance tween, so a re-send can replace it instead of stacking. */
  entranceTween: gsap.core.Tween | null;
}

/**
 * Draws a circular avatar: the portrait clipped to a ring, or the fallback
 * letter on a gradient disc when no portrait is available.
 *
 * The result is a texture rather than an `<img>` because it becomes the map of
 * a sprite. The white ring, the gradient and the drop shadow reproduce the DOM
 * avatar this replaced (`border: 2px solid rgba(255,255,255,.9)` over a
 * 135deg pink→cyan gradient, `box-shadow: 0 6px 14px rgba(0,0,0,.28)`), so the
 * portraits keep the look they had in `mpr-overlay`.
 */
/**
 * Geometry shared by the two avatar textures, as fractions of the texture.
 *
 * The disc and the frame are drawn into **separate** textures so the frame can
 * never be affected by the portrait: a portrait fills the disc to the ring's
 * inner edge, and when the 256px texture is minified onto a ~30px avatar the
 * ~7% ring sliver aliases away, which is why a loaded portrait showed no border
 * while the fallback did. Keeping them apart also lets the frame composite on
 * top of whatever the disc contains.
 */
const RING_FRACTION = 0.095;
/** Disc box as a fraction of the texture height; the rest is the pointer tail. */
const DISC_FRACTION = 0.78;
const POINTER_HALF_FRACTION = 0.3;
/** Longest stagger any avatar waits, in steps (`index * staggerMs`). */
const MAX_STAGGER_STEPS = 8;
/** Cooldown before a failed portrait URL gets one more chance to recover. */
const FAILED_PORTRAIT_RETRY_MS = 30_000;

interface AvatarGeometry {
  cx: number;
  cy: number;
  r: number;
  inner: number;
  ring: number;
}

/** Resolves the disc/ring metrics for a texture of `sizePx`, with or without a pointer. */
export function avatarGeometry(sizePx: number, pointer: boolean): AvatarGeometry {
  const discBox = pointer ? sizePx * DISC_FRACTION : sizePx;
  const r = (discBox / 2) * 0.98;
  const inner = r * (1 - RING_FRACTION);
  return {
    cx: sizePx / 2,
    cy: pointer ? r + sizePx * 0.012 : sizePx / 2,
    r,
    inner,
    ring: r - inner,
  };
}

/**
 * Draws the avatar's **frame**: the white border ring, the per-resident accent
 * and the pointer, on a transparent canvas.
 *
 * This is deliberately a texture of its own (see {@link RING_FRACTION}): it is
 * composited over the disc instead of competing with the portrait inside one
 * canvas, so the border renders identically whether the portrait loaded or not.
 */
export function drawAvatarFrame(accent: string, sizePx = 256, pointer = true): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const { cx, cy, r, inner, ring } = avatarGeometry(sizePx, pointer);

  // Pointer first: it sits under the ring so the shoulders join cleanly.
  if (pointer) {
    const half = r * POINTER_HALF_FRACTION;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = sizePx * 0.045;
    ctx.shadowOffsetY = sizePx * 0.02;
    ctx.beginPath();
    ctx.moveTo(cx - half, cy + r - ring * 1.2);
    ctx.lineTo(cx + half, cy + r - ring * 1.2);
    ctx.lineTo(cx, sizePx * 0.995);
    ctx.closePath();
    ctx.fillStyle = 'rgba(9,10,18,0.96)';
    ctx.fill();
    ctx.lineWidth = Math.max(3, ring * 0.45);
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.stroke();
    ctx.restore();
  }

  // Accent ring, just inside the border.
  ctx.beginPath();
  ctx.arc(cx, cy, inner - ring * 0.3, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(3, ring * 0.72);
  ctx.stroke();

  // The white border as a filled annulus: a hairline stroke of the same nominal
  // width is the first thing to disappear when the texture is minified.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.shadowColor = accent;
  ctx.shadowBlur = sizePx * 0.035;
  ctx.fill('evenodd');
  ctx.shadowBlur = 0;

  return canvas;
}

/**
 * Draws the avatar's **disc**: the portrait clipped into the circle, or — with
 * no portrait — a dark accent-tinted disc carrying the fallback label.
 *
 * The dark fallback matches the DOM stack it replaces and keeps its white label
 * readable under the `mpr-haze` overlay, where a bright gradient washes out.
 */
export function drawAvatarDisc(portrait: CanvasImageSource | null, label: string, accent: string, sizePx = 256, pointer = true): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const { cx, cy, inner } = avatarGeometry(sizePx, pointer);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.clip();
  if (portrait) {
    ctx.filter = 'saturate(1.22) contrast(1.12) brightness(1.08)';
    ctx.drawImage(portrait, cx - inner, cy - inner, inner * 2, inner * 2);
    ctx.filter = 'none';
  } else {
    ctx.fillStyle = 'rgba(7,10,18,0.98)';
    ctx.fillRect(cx - inner, cy - inner, inner * 2, inner * 2);
    const glow = ctx.createLinearGradient(cx - inner, cy - inner, cx + inner, cy + inner);
    glow.addColorStop(0, accent);
    glow.addColorStop(0.48, 'rgba(252,42,119,0.92)');
    glow.addColorStop(1, 'rgba(24,221,217,0.94)');
    ctx.globalAlpha = 0.76;
    ctx.fillStyle = glow;
    ctx.fillRect(cx - inner, cy - inner, inner * 2, inner * 2);
    const shine = ctx.createRadialGradient(cx - inner * 0.34, cy - inner * 0.42, inner * 0.08, cx - inner * 0.22, cy - inner * 0.28, inner * 0.78);
    shine.addColorStop(0, 'rgba(255,255,255,0.34)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(cx - inner, cy - inner, inner * 2, inner * 2);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (!portrait && label) {
    ctx.fillStyle = '#fff';
    // Fit inside the disc: the label may be a two- or three-digit count.
    const chars = label.length;
    const fontSize = Math.round(inner * (chars > 3 ? 0.5 : chars > 2 ? 0.62 : chars > 1 ? 0.8 : 1.05));
    ctx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy, inner * 1.5);
  }
  return canvas;
}

/**
 * Applies a brightness multiplier to a sprite.
 *
 * `SpriteMaterial` is unlit — it has no `emissive` and ignores the scene's
 * lights — so an avatar cannot inherit the world's lighting. Scaling the
 * material colour is the equivalent control: 1 leaves the texture as authored,
 * >1 lifts it out of a dark theme.
 */
function setBrightness(material: SpriteMaterial, brightness: number): void {
  // Allow a small lift: world sprites sit below the DOM haze/vignette, so a
  // mild material boost keeps portraits from reading grey without blowing them
  // out like the old 1.9 multiplier did.
  const scaled = Math.min(1.16, Math.max(0, brightness));
  material.color.setRGB(scaled, scaled, scaled);
}

/**
 * Tags a canvas texture as sRGB.
 *
 * Canvas pixels are sRGB-encoded. Without this tag three.js reads them as
 * linear and the renderer's linear→sRGB output brightens every midtone, so an
 * avatar renders washed out even where no overlay covers it. The engine's own
 * canvas textures (`theme/textures.ts`, `game/drops.ts`) tag theirs the same
 * way.
 */
function asColorTexture(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * `easeOutBack`: overshoots past 1 then settles, which is what makes an
 * entrance read as a "pop" rather than a fade. `s` controls the overshoot.
 */
export function easeOutBack(t: number, s = 1.9): number {
  if (!Number.isFinite(t)) return 1;
  const c = s + 1;
  const u = t - 1;
  const v = 1 + c * u * u * u + s * u * u;
  // Floored at 15%: the entrance is decoration, and it must never be able to
  // leave an avatar invisible — which is what happened when a re-sent layer kept
  // restarting it from zero.
  return Math.max(0.15, Math.min(1.25, v));
}

/** Frame time an avatar's entrance starts at, given its layer order. */
export function entranceDelay(spec: WorldAvatarSpec, index: number): number {
  const e = spec.entrance;
  if (!e) return 0;
  // The stagger is capped: with dozens of residents an uncapped `index * stagger`
  // would hold the last avatar at zero scale for seconds.
  return (e.delayMs ?? 0) + Math.min(index, MAX_STAGGER_STEPS) * (e.staggerMs ?? 90);
}

/** A `CanvasTexture` for an avatar's disc (portrait or fallback label). */
function discTexture(portrait: CanvasImageSource | null, label: string, accent: string, pointer: boolean): Texture {
  return asColorTexture(new CanvasTexture(drawAvatarDisc(portrait, label, accent, 256, pointer)));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawStackFace(ctx: CanvasRenderingContext2D, face: WorldAvatarFaceSpec, portrait: CanvasImageSource | null, x: number, y: number, d: number, index: number): void {
  const accent = face.color ?? (index % 2 ? '#18ddd9' : '#fc2a77');
  const c = d / 2;
  const rim = Math.max(7, d * 0.07);
  const inset = Math.max(13, d * 0.12);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + c, y + c, c, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.98)';
  ctx.fill();
  ctx.shadowColor = index % 2 ? 'rgba(24,221,217,0.28)' : 'rgba(252,42,119,0.30)';
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.arc(x + c, y + c, c - rim, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = rim;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(x + c, y + c, c - inset, 0, Math.PI * 2);
  ctx.clip();
  if (portrait) {
    ctx.filter = 'saturate(1.2) contrast(1.12) brightness(1.08)';
    ctx.drawImage(portrait, x + inset, y + inset, d - inset * 2, d - inset * 2);
    ctx.filter = 'none';
  } else {
    const gradient = ctx.createLinearGradient(x, y, x + d, y + d);
    gradient.addColorStop(0, 'rgba(6,9,18,0.99)');
    gradient.addColorStop(0.44, accent);
    gradient.addColorStop(1, 'rgba(24,221,217,0.96)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x + inset, y + inset, d - inset * 2, d - inset * 2);
    const label = (face.fallbackLabel ?? '?').slice(0, 2).toUpperCase();
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${label.length > 1 ? Math.round(d * 0.34) : Math.round(d * 0.46)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + c, y + c + 1);
  }
  ctx.restore();
}

export function drawAvatarStack(faces: WorldAvatarFaceSpec[], portraits: (CanvasImageSource | null)[], overflowLabel: string, accent: string, selected: boolean, widthPx = 384, heightPx = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const visible = faces.slice(0, 3);
  const pillWidth = visible.length <= 1 ? 226 : visible.length === 2 ? 304 : 354;
  const pill = { x: (widthPx - pillWidth) / 2, y: 27, w: pillWidth, h: 156, r: 78 };
  const pinX = pill.x + pill.w / 2;
  const tailY = heightPx - 7;

  const glow = ctx.createRadialGradient(pinX, 108, 10, pinX, 108, selected ? 174 : 150);
  glow.addColorStop(0, selected ? 'rgba(252,42,119,0.42)' : 'rgba(24,221,217,0.30)');
  glow.addColorStop(0.52, selected ? 'rgba(24,221,217,0.24)' : 'rgba(252,42,119,0.18)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.save();
  ctx.shadowColor = selected ? 'rgba(252,42,119,0.44)' : 'rgba(0,0,0,0.34)';
  ctx.shadowBlur = selected ? 34 : 24;
  ctx.shadowOffsetY = 12;
  roundRect(ctx, pill.x, pill.y, pill.w, pill.h, pill.r);
  ctx.moveTo(pinX - 23, pill.y + pill.h - 8);
  ctx.lineTo(pinX + 23, pill.y + pill.h - 8);
  ctx.lineTo(pinX, tailY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(5,7,14,0.98)';
  ctx.fill();
  ctx.restore();

  roundRect(ctx, pill.x + 2, pill.y + 2, pill.w - 4, pill.h - 4, pill.r - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.97)';
  ctx.lineWidth = 4;
  ctx.stroke();
  roundRect(ctx, pill.x + 9, pill.y + 9, pill.w - 18, pill.h - 18, pill.r - 9);
  ctx.strokeStyle = selected ? '#fc2a77' : accent;
  ctx.lineWidth = 3;
  ctx.globalAlpha = selected ? 0.94 : 0.68;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(pinX - 22, pill.y + pill.h - 11);
  ctx.lineTo(pinX + 22, pill.y + pill.h - 11);
  ctx.lineTo(pinX, tailY - 4);
  ctx.closePath();
  ctx.fillStyle = 'rgba(5,7,14,0.98)';
  ctx.fill();
  ctx.strokeStyle = selected ? 'rgba(252,42,119,0.88)' : 'rgba(24,221,217,0.68)';
  ctx.lineWidth = 3;
  ctx.stroke();

  const d = 118;
  const gap = 76;
  const groupW = d + Math.max(0, visible.length - 1) * gap;
  const startX = pinX - groupW / 2;
  for (let i = visible.length - 1; i >= 0; i--) drawStackFace(ctx, visible[i]!, portraits[i] ?? null, startX + i * gap, 46 + (i % 2) * 8, d, i);

  if (overflowLabel) {
    const bx = Math.min(pill.x + pill.w - 78, startX + visible.length * gap + 6);
    const by = 47;
    ctx.save();
    ctx.shadowColor = 'rgba(252,42,119,0.36)';
    ctx.shadowBlur = 14;
    roundRect(ctx, bx, by, 72, 52, 26);
    ctx.fillStyle = selected ? 'rgba(252,42,119,0.98)' : 'rgba(15,18,28,0.94)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${overflowLabel.length > 2 ? 20 : 24}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(overflowLabel, bx + 36, by + 26);
    ctx.restore();
  }

  return canvas;
}

/**
 * A soft ring used as the attention halo behind an avatar. Drawn on its own
 * texture so the pulse can scale and fade it without touching the disc.
 */
function haloTexture(accent: string, sizePx = 256): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = sizePx / 2;
    ctx.beginPath();
    ctx.arc(c, c, sizePx * 0.34, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = sizePx * 0.09;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, sizePx * 0.30, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.18;
    ctx.fill();
  }
  return asColorTexture(new CanvasTexture(canvas));
}

/** A `CanvasTexture` for an avatar's frame (border, accent, pointer). */
function frameTexture(accent: string, pointer: boolean): Texture {
  return asColorTexture(new CanvasTexture(drawAvatarFrame(accent, 256, pointer)));
}

function emptyTexture(sizePx = 8): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  return asColorTexture(new CanvasTexture(canvas));
}

function avatarWidth(spec: WorldAvatarSpec): number {
  return spec.widthMeters ?? DEFAULT_AVATAR_METERS;
}

function avatarHeight(spec: WorldAvatarSpec): number {
  return spec.heightMeters ?? spec.widthMeters ?? DEFAULT_AVATAR_METERS;
}

function stackSignature(spec: WorldAvatarSpec): string {
  const stack = spec.stack;
  if (!stack) return '';
  return [
    stack.selected ? 'selected' : 'idle',
    stack.overflowLabel ?? '',
    ...stack.faces.map((face) => `${face.uri ?? ''}:${face.fallbackLabel ?? ''}:${face.color ?? ''}`),
  ].join('|');
}

/**
 * Owns every world-model avatar quad, grouped under `world-avatars`.
 *
 * Placement mirrors a marker's: the coordinate is projected to world units and
 * `anchorHeight` / `snapToBuilding` resolve against the loaded world, so an
 * avatar with `anchorHeight: 'roof'` stands on the building it belongs to
 * instead of floating at ground level next to it.
 */
export class WorldAvatars {
  private readonly group = new Group();
  private readonly portraitCache = new Map<string, Texture>();
  /**
   * URIs whose portrait already failed (blocked by CORS, offline, 404).
   *
   * Without this every re-send of the layer retries the load: the browser logs
   * the CORS error again each time, and the disc texture is rebuilt and swapped,
   * which flickers the avatar instead of leaving its fallback up. The memory is
   * time-bound because Telegram WebView / mobile networks can drop an otherwise
   * good portrait once; one transient failure should not pin a resident to a
   * fallback disc for the whole map session.
   */
  private readonly failedPortraits = new Map<string, number>();
  /**
   * In-flight portrait loads, keyed by URI.
   *
   * Without this, N avatars with the same portrait (or a re-sent layer racing
   * an earlier send) would issue N identical requests; with it, the first one
   * wins and the rest await it.
   */
  private readonly pendingPortraits = new Map<string, Promise<Texture | null>>();
  /**
   * Spec ids whose entrance has already played.
   *
   * Keyed by id rather than by the `Avatar` object: the layer can be re-sent
   * often, and when it is, the engine may hand back a fresh set of entries, so
   * `previous.find(...)` finds nothing and every avatar looked "new". Re-arming
   * the entrance then reset every avatar to zero scale on each send, which left
   * them invisible for as long as the sends kept coming.
   */
  private readonly enteredIds = new Set<string>();
  private readonly layers = new Map<string, Avatar[]>();
  private readonly avatars: Avatar[] = [];
  /** Monotonic creation counter, used to stagger entrances independently of the layer's ordering. */
  private sequence = 0;
  /** Per-frame bob hook, installed only while at least one avatar floats. */
  private offFrame: (() => void) | null = null;
  /** Release of the `avatars` active source held while bobbing. */
  private offRelease: (() => void) | null = null;
  /** Frame time the current bob cycle started at; `null` until the first frame. */
  private startedAt: number | null = null;
  private disposed = false;

  constructor(
    private readonly scene: SceneApi,
    /** The engine's shared anchor lookup, so an avatar resolves exactly like a marker. */
    private readonly anchorContext: () => AnchorContext | null,
  ) {
    this.group.name = 'world-avatars';
    scene.groups.dynamic.add(this.group);
  }

  /** Replaces one avatar layer. */
  async setLayer(layerId: string, specs: WorldAvatarSpec[]): Promise<void> {
    // Load every distinct portrait **concurrently** before building anything.
    // Awaiting each texture inside the build loop serialised the loads, so a
    // layer of N avatars took N round-trips and they appeared one after another.
    await Promise.all(
      [...new Set(specs.map((spec) => this.keyOf(spec)))]
        .filter((key) => key.startsWith('http') || key.startsWith('data:') || key.startsWith('/'))
        .map((key) => {
          const spec = specs.find((s) => this.keyOf(s) === key)!;
          return this.texture(spec, key).catch(() => null);
        }),
    );
    if (this.disposed) return;

    const previous = this.layers.get(layerId) ?? [];
    const next: Avatar[] = [];
    for (const [index, spec] of specs.entries()) {
      const reused = previous.find((a) => a.spec.id === spec.id);
      const avatar = reused ?? (await this.create(spec));
      if (this.disposed) return;
      avatar.spec = spec;
      await this.applyTexture(avatar, spec);
      this.place(avatar, spec);
      if (spec.entrance && !this.enteredIds.has(spec.id)) {
        // An avatar plays its entrance exactly once. A re-sent layer must never
        // re-arm it, or the avatar sits at reduced scale for as long as the
        // re-sends keep arriving — which is what hid them. Under reduced motion
        // the entrance is not played at all: it settles straight into place.
        if (this.scene.reduceMotion) this.settleEntrance(avatar, spec);
        else this.playEntrance(avatar, spec, entranceDelay(spec, Math.min(index, MAX_STAGGER_STEPS)));
      } else if (!spec.entrance) {
        this.cancelEntrance(avatar);
      }
      next.push(avatar);
    }
    for (const old of previous) if (!next.includes(old)) this.release(old);
    this.layers.set(layerId, next);
    this.sync();
  }

  /** Removes one layer. */
  removeLayer(layerId: string): void {
    const list = this.layers.get(layerId);
    if (!list) return;
    this.layers.delete(layerId);
    for (const a of list) this.release(a);
    this.sync();
  }

  /** Re-places every avatar: called after a world load or a theme rebuild. */
  refresh(): void {
    for (const a of this.avatars) this.place(a, a.spec);
    this.scene.requestRender();
  }

  private sync(): void {
    this.avatars.length = 0;
    for (const list of this.layers.values()) this.avatars.push(...list);
    for (const a of this.avatars) {
      if (!a.sprite.parent) this.group.add(a.sprite);
      if (!a.frame.parent) this.group.add(a.frame);
      if (a.halo && !a.halo.parent) this.group.add(a.halo);
    }
    // Detach anything no longer owned by a layer.
    const live = new Set(this.avatars.flatMap((a) => (a.halo ? [a.sprite, a.frame, a.halo] : [a.sprite, a.frame])));
    for (const child of [...this.group.children]) if (!live.has(child as Sprite)) this.group.remove(child);
    this.syncAnimation();
    this.scene.requestRender();
  }

  private async create(spec: WorldAvatarSpec): Promise<Avatar> {
    const width = avatarWidth(spec);
    const height = avatarHeight(spec);
    const key = this.keyOf(spec);
    const accent = spec.color ?? '#fc2a77';
    const pointer = spec.pointer ?? false;
    const portrait = spec.stack ? null : await this.texture(spec, key);
    const texture = spec.stack ? await this.stackTexture(spec, accent) : this.discFor(portrait, spec, accent, pointer);
    // `depthTest: false` is deliberate: an avatar sits on a roof and is taller
    // than the building's own top surface, so a depth-tested quad gets swallowed
    // by the building mesh and looks embedded in it. The DOM avatars this
    // replaces were drawn over the canvas and were never occluded either.
    const material = this.discMaterial(texture, spec.brightness ?? 1);
    const sprite = new Sprite(material);
    sprite.scale.set(width, height, 1);
    sprite.renderOrder = 20 + (spec.z ?? 0);
    this.group.add(sprite);
    const frameMaterial = spec.stack ? this.discMaterial(emptyTexture(), spec.brightness ?? 1) : this.frameMaterial(accent, pointer, spec.brightness ?? 1);
    const frame = new Sprite(frameMaterial);
    frame.scale.set(width, height, 1);
    // Keep the pair in the same depth-sorted bucket. Equal depth falls back to
    // object id, so this later-created frame draws immediately after its disc.
    // A higher order would draw EVERY frame over EVERY portrait in the layer.
    frame.renderOrder = sprite.renderOrder;
    this.group.add(frame);
    // `discKey` starts empty so the first update builds the disc once; a failed
    // portrait is remembered briefly in `failedPortraits` so constant layer
    // re-sends do not hammer the same bad URL.
    const avatar: Avatar = {
      spec, sprite, material, texture, key, frame, frameMaterial, usingFallback: !portrait, discKey: '',
      baseY: 0, amplitude: 0, appliedW: width, appliedH: height,
      sequence: this.sequence++,
      motion: { startedAt: null, pendingDelayMs: null, durationMs: spec.entrance?.durationMs ?? 520, entered: false },
      halo: null, haloMaterial: null, entranceTween: null,
    };
    this.syncHalo(avatar, spec, accent);
    return avatar;
  }

  private async applyTexture(avatar: Avatar, spec: WorldAvatarSpec): Promise<void> {
    const key = this.keyOf(spec);
    const accent = spec.color ?? '#fc2a77';
    const pointer = spec.pointer ?? false;
    // Everything the disc depends on, so an unchanged re-send of the layer does
    // no work: no texture swap (which flickers) and no re-request.
    const discKey = `${key}|${spec.fallbackLabel ?? ''}|${accent}|${pointer}|${stackSignature(spec)}`;
    this.syncHalo(avatar, spec, accent);
    const fallbackRetryDue = avatar.usingFallback && (spec.stack ? this.stackHasRetryablePortrait(spec) : this.isPortraitRetryDue(key));
    if (discKey === avatar.discKey && !fallbackRetryDue) return;
    const portrait = spec.stack ? null : await this.texture(spec, key);
    const texture = spec.stack ? await this.stackTexture(spec, accent) : this.discFor(portrait, spec, accent, pointer);
    // Disc and frame are separate textures; replace both so the accent and the
    // pointer stay in step with the spec.
    avatar.texture.dispose();
    avatar.texture = texture;
    avatar.material.map = texture;
    setBrightness(avatar.material, spec.brightness ?? 1);
    avatar.material.needsUpdate = true;
    const frameTexture2 = spec.stack ? emptyTexture() : frameTexture(accent, pointer);
    avatar.frameMaterial.map?.dispose();
    avatar.frameMaterial.dispose();
    const fm = this.discMaterial(frameTexture2, spec.brightness ?? 1);
    avatar.frame.material = fm;
    avatar.frameMaterial = fm;
    avatar.key = key;
    avatar.discKey = discKey;
    avatar.usingFallback = !portrait;
    const width = avatarWidth(spec);
    const height = avatarHeight(spec);
    // A running entrance owns scale/opacity; only the resting state is written
    // here, so the tween is not cancelled out on every texture swap.
    if (!avatar.entranceTween) {
      avatar.appliedW = width;
      avatar.appliedH = height;
      avatar.sprite.scale.set(width, height, 1);
      avatar.frame.scale.set(width, height, 1);
    }
  }

  /**
   * Plays an avatar's entrance with gsap: it fades, rises and overshoots into
   * place, then hands the sprite back to the resting values.
   *
   * The bob/float path in `frame()` drives `position.y` too, so the rise is a
   * gsap tween on a *separate* proxy — not on the sprite — and the frame loop
   * keeps ownership of the resting transform. That avoids two systems writing
   * the same property.
   */
  private playEntrance(avatar: Avatar, spec: WorldAvatarSpec, delayMs: number): void {
    this.cancelEntrance(avatar);
    // Claim the id *when the entrance starts*, not when it completes. The app
    // re-sends whole avatar layers (tapping a residence, closing the roster), and
    // a re-send that lands inside the entrance window used to find the id still
    // unclaimed and restart the tween — every pop visibly replayed mid-flight.
    this.enteredIds.add(spec.id);
    const width = avatarWidth(spec);
    const height = avatarHeight(spec);
    const durationMs = spec.entrance?.durationMs ?? 520;
    const state = { scale: 0.2, opacity: 0 };
    avatar.material.opacity = 0;
    avatar.motion.startedAt = null;
    avatar.motion.pendingDelayMs = null;
    // Cancel any in-flight ballistics so the transform below is the last writer
    // for the duration of the tween.
    avatar.entranceTween = gsap.to(state, {
      scale: 1,
      opacity: spec.brightness !== 0 ? 1 : 1,
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: 'back.out(2.2)',
      onUpdate: () => {
        // The tween owns the size while it runs, so the guard has to follow it;
        // otherwise the resting write below would fight the overshoot.
        avatar.appliedW = Math.max(0.15, width * state.scale);
        avatar.appliedH = Math.max(0.15, height * state.scale);
        avatar.sprite.scale.set(avatar.appliedW, avatar.appliedH, 1);
        avatar.frame.scale.set(avatar.appliedW, avatar.appliedH, 1);
        avatar.material.opacity = state.opacity;
        avatar.frameMaterial.opacity = state.opacity;
        this.scene.requestRender();
      },
      onComplete: () => {
        // The id was already claimed when the tween started; only the settled
        // state is left to record here.
        avatar.motion.entered = true;
        avatar.appliedW = width;
        avatar.appliedH = height;
        avatar.sprite.scale.set(width, height, 1);
        avatar.frame.scale.set(width, height, 1);
        avatar.material.opacity = 1;
        avatar.frameMaterial.opacity = 1;
        avatar.entranceTween = null;
        this.scene.requestRender();
      },
    });
  }

  /**
   * Settles an entrance without tweening: reduced motion applies the final
   * scale/position at once, so the avatar is fully visible immediately.
   */
  private settleEntrance(avatar: Avatar, spec: WorldAvatarSpec): void {
    this.cancelEntrance(avatar);
    // Remembered like a completed tween, so a re-sent layer never re-arms it.
    this.enteredIds.add(spec.id);
    avatar.motion.entered = true;
  }

  /** Cancels a running entrance and restores the resting transform. */
  private cancelEntrance(avatar: Avatar): void {
    if (avatar.entranceTween) {
      avatar.entranceTween.kill();
      avatar.entranceTween = null;
    }
    const width = avatarWidth(avatar.spec);
    const height = avatarHeight(avatar.spec);
    avatar.appliedW = width;
    avatar.appliedH = height;
    avatar.sprite.scale.set(width, height, 1);
    avatar.frame.scale.set(width, height, 1);
    avatar.material.opacity = 1;
    avatar.frameMaterial.opacity = 1;
  }

  private place(avatar: Avatar, spec: WorldAvatarSpec): void {
    const proj = this.scene.projection();
    const ctx = this.anchorContext();
    const point = resolveMarkerPoint(
      {
        id: spec.id,
        coordinate: spec.coordinate,
        anchorHeight: spec.anchorHeight ?? 'roof',
        snapToBuilding: spec.snapToBuilding,
      },
      proj,
      ctx,
    );
    // A roof anchor belongs on the building it snapped to, not at ground level.
    const roofY = point.buildingId ? (ctx?.roofY(point.buildingId) ?? null) : null;
    const base = (roofY ?? (ctx?.groundY ?? groundYFor(this.scene.world()?.kind)) + point.lift) + (spec.elevationMeters ?? 0);
    const height = avatarHeight(spec);
    const y = spec.anchor === 'center' ? base + height / 2 : spec.anchor === 'top' ? base + height : base;
    avatar.baseY = y;
    avatar.amplitude = spec.float?.amplitudeMeters ?? 0;
    avatar.sprite.position.set(point.x, y, point.z);
    avatar.frame.position.set(point.x, y, point.z);
    avatar.sprite.renderOrder = 20 + (spec.z ?? 0);
    // Preserve the disc/frame pair when selection changes the avatar priority.
    avatar.frame.renderOrder = avatar.sprite.renderOrder;
    // Under reduced motion the frame loop never runs for a pulsing avatar (see
    // `frame`), so nothing else would position its ring: park it on the avatar
    // here, at the pulse's widest extent, as a static accent. Whether the ring
    // exists at all is `syncHalo`'s call — it disposes the halo the moment a
    // re-sent layer drops `pulse`, so a deselected residence cannot keep it.
    if (spec.pulse && avatar.halo && this.scene.reduceMotion) {
      const grow = spec.pulse.scale ?? 1.5;
      const ring = Math.max(avatarWidth(spec), avatarHeight(spec)) * grow;
      avatar.halo.position.set(point.x, y, point.z);
      avatar.halo.scale.set(ring, ring, 1);
      if (avatar.haloMaterial) avatar.haloMaterial.opacity = 0.4;
    }
  }

  /**
   * Bobs every floating avatar, reproducing the DOM stack's
   * `maprama-residence-float` (`translateY(0 → -3px)`, ease-in-out). The frame
   * loop is on demand, so this also holds an active source while it runs.
   */
  private frame(now: number): void {
    // `null` rather than a falsy check: frame time 0 is a legitimate start, and
    // treating it as "unset" re-initialises the clock on every frame.
    if (this.startedAt === null) this.startedAt = now;
    const started = this.startedAt;
    const elapsedMs = (now - started) * 1000;
    // Reduced motion has already written the resting transform (`place` /
    // `settleEntrance`), so the bob, the breathe and the halo pulse do not count
    // as motion here: the loop must not re-arm them, and `syncAnimation` holds no
    // source for them, so a settled reduced-motion map reaches 0 frames.
    const rm = this.scene.reduceMotion;
    for (const a of this.avatars) {
      const p = rm ? undefined : a.spec.pulse;
      const breathe = rm ? undefined : a.spec.breathe;
      const entering = a.entranceTween !== null;
      const floating = !rm && a.amplitude > 0;
      if (!floating && !p && !breathe && !entering) continue;

      let bob = 0;
      if (floating) {
        const period = a.spec.float?.periodMs ?? 3_200;
        // `(1 - cos) / 2` is 0 → 1 → 0, matching the 0/50/100% keyframes.
        const t = (1 - Math.cos((elapsedMs / period) * Math.PI * 2)) / 2;
        bob = a.amplitude * t;
      }

      // The entrance is gsap-owned (`playEntrance`); this loop only writes the
      // resting transform, and only while no tween is running, so the two never
      // fight over `scale`/`position`.
      const width = avatarWidth(a.spec);
      const height = avatarHeight(a.spec);
      const scale = a.entranceTween ? a.sprite.scale.x / width : 1;
      let bodyScale = 1;
      if (breathe && !a.entranceTween) {
        const period = breathe.periodMs ?? 2_600;
        const phase = (1 - Math.cos((elapsedMs / period) * Math.PI * 2)) / 2;
        bodyScale = 1 + phase * ((breathe.scale ?? 1.04) - 1);
      }

      a.sprite.position.y = a.baseY + bob;
      a.frame.position.y = a.sprite.position.y;
      // The size only changes when the spec size changes, while breathing, or
      // while an entrance owns it, so a frame that lands on the applied size
      // writes nothing. `breathe` is `undefined` under reduced motion, so a
      // reduced-motion map never re-applies the same values.
      const w = width * bodyScale, h = height * bodyScale;
      if (!a.entranceTween && (a.appliedW !== w || a.appliedH !== h)) {
        a.appliedW = w;
        a.appliedH = h;
        a.sprite.scale.set(w, h, 1);
        a.frame.scale.set(w, h, 1);
      }

      if (a.halo && p) {
        // The halo keeps pulsing even after the entrance settles: an expanding
        // ring is what makes an avatar read as "the important thing here".
        // `syncHalo` owns whether the ring exists (`p` is undefined under
        // reduced motion, which leaves the static ring `place` parked).
        const period = p.periodMs ?? 2_400;
        const phase = (elapsedMs % period) / period;
        const grow = 1 + phase * ((p.scale ?? 1.5) - 1);
        const haloSize = Math.max(width, height) * grow * scale;
        a.halo.position.set(a.sprite.position.x, a.sprite.position.y, a.sprite.position.z);
        a.halo.scale.set(haloSize, haloSize, 1);
        if (a.haloMaterial) a.haloMaterial.opacity = 0.45 * (1 - phase);
      }
    }
    // No `requestRender()` here: this hook is installed by `syncAnimation` in
    // the same branch that takes the `avatars` source, and removed in the same
    // branch that releases it, so a running frame hook always means the loop is
    // already awake. If the source is released mid-frame there is nothing left
    // to animate, so no extra frame is owed either.
  }

  /** Keeps the bob loop and its active source in step with the avatar list. */
  private syncAnimation(): void {
    // A pending entrance counts too: without it the on-demand render loop could
    // go idle before the entrance ran and leave the avatar at zero scale.
    // Reduced motion animates none of the bob, the breathe and the halo, so
    // those must not hold the loop: their resting state is written once by
    // `place` (`frame` skips them for the same reason).
    const rm = this.scene.reduceMotion;
    const wanted = this.avatars.some(
      (a) =>
        (!rm && (a.amplitude > 0 || !!a.spec.pulse || !!a.spec.breathe)) ||
        a.motion.startedAt !== null ||
        a.motion.pendingDelayMs !== null,
    );
    if (wanted && !this.offFrame) {
      this.startedAt = null;
      this.offRelease = this.scene.addActiveSource('avatars');
      this.offFrame = this.scene.onFrame((_dt, t) => this.frame(t));
    }
    if (!wanted && this.offFrame) {
      this.offFrame();
      this.offRelease?.();
      this.offFrame = null;
      this.offRelease = null;
    }
  }

  private keyOf(spec: WorldAvatarSpec): string {
    if (spec.stack) return `stack:${stackSignature(spec)}`;
    return spec.uri ?? `fallback:${(spec.fallbackLabel ?? '').slice(0, 1).toUpperCase()}:${spec.color ?? ''}`;
  }

  /**
   * The disc texture for a spec: the portrait's image clipped into the circle,
   * or the labelled fallback. Separate from the frame texture so the frame is
   * never affected by what the disc contains.
   */
  private discFor(portrait: Texture | null, spec: WorldAvatarSpec, accent: string, pointer: boolean): Texture {
    const image = (portrait?.image ?? null) as CanvasImageSource | null;
    return discTexture(image, spec.fallbackLabel ?? '', accent, pointer);
  }

  private async stackTexture(spec: WorldAvatarSpec, accent: string): Promise<Texture> {
    const stack = spec.stack;
    if (!stack) return discTexture(null, spec.fallbackLabel ?? '', accent, false);
    const portraits = await Promise.all(stack.faces.map((face) => {
      if (!face.uri) return Promise.resolve(null);
      return this.texture({ ...spec, uri: face.uri, stack: undefined, fallbackLabel: face.fallbackLabel, color: face.color }, face.uri).catch(() => null);
    }));
    const images = portraits.map((portrait) => (portrait?.image ?? null) as CanvasImageSource | null);
    return asColorTexture(new CanvasTexture(drawAvatarStack(stack.faces, images, stack.overflowLabel ?? '', accent, !!stack.selected)));
  }

  private syncHalo(avatar: Avatar, spec: WorldAvatarSpec, accent: string): void {
    if (!spec.pulse) {
      if (avatar.halo) this.group.remove(avatar.halo);
      avatar.haloMaterial?.map?.dispose();
      avatar.haloMaterial?.dispose();
      avatar.halo = null;
      avatar.haloMaterial = null;
      return;
    }
    if (!avatar.halo) {
      avatar.haloMaterial = this.discMaterial(haloTexture(accent), spec.brightness ?? 1);
      avatar.haloMaterial.opacity = 0.4;
      avatar.halo = new Sprite(avatar.haloMaterial);
      this.group.add(avatar.halo);
    }
    const size = Math.max(avatarWidth(spec), avatarHeight(spec));
    avatar.halo.scale.set(size, size, 1);
    avatar.halo.renderOrder = 19 + (spec.z ?? 0);
  }

  /** Sprite material for a disc. Unlit, so `brightness` is the only lever. */
  private discMaterial(texture: Texture, brightness: number): SpriteMaterial {
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false });
    material.toneMapped = false;
    setBrightness(material, brightness);
    return material;
  }

  /** Sprite material for a frame (border, accent, pointer). */
  private frameMaterial(accent: string, pointer: boolean, brightness: number): SpriteMaterial {
    return this.discMaterial(frameTexture(accent, pointer), brightness);
  }

  private async texture(spec: WorldAvatarSpec, key: string): Promise<Texture | null> {
    const cached = this.portraitCache.get(key);
    if (cached) return cached;
    // No portrait at all is not a failure: the caller draws the fallback disc.
    if (!spec.uri) return null;
    // Recently known bad: stay on the fallback instead of re-requesting on every
    // layer sync. Once the cooldown expires, drop the failure and try again.
    if (this.isPortraitCoolingDown(key)) return null;
    const inFlight = this.pendingPortraits.get(key);
    if (inFlight) return inFlight;
    const load = this.loadPortrait(spec, key);
    this.pendingPortraits.set(key, load);
    try {
      return await load;
    } finally {
      this.pendingPortraits.delete(key);
    }
  }

  /** One portrait request; cached on success, remembered on failure. */
  private async loadPortrait(spec: WorldAvatarSpec, key: string): Promise<Texture | null> {
    try {
      const texture = await new Promise<Texture>((resolve, reject) => {
        new TextureLoader().load(
          spec.uri!,
          (t) => {
            t.needsUpdate = true;
            resolve(t);
          },
          undefined,
          // A blocked portrait is routine (a CDN without CORS headers, an
          // offline host). One bad URI must never fail the whole layer.
          () => reject(new Error(`avatar portrait could not be loaded: ${spec.uri}`)),
        );
      });
      this.portraitCache.set(key, texture);
      this.failedPortraits.delete(key);
      return texture;
    } catch {
      this.failedPortraits.set(key, Date.now());
      return null;
    }
  }

  private isPortraitRetryDue(key: string): boolean {
    const failedAt = this.failedPortraits.get(key);
    return failedAt !== undefined && Date.now() - failedAt >= FAILED_PORTRAIT_RETRY_MS;
  }

  private isPortraitCoolingDown(key: string): boolean {
    if (!this.isPortraitRetryDue(key)) return this.failedPortraits.has(key);
    this.failedPortraits.delete(key);
    return false;
  }

  private stackHasRetryablePortrait(spec: WorldAvatarSpec): boolean {
    return spec.stack?.faces.some((face) => !!face.uri && this.isPortraitRetryDue(face.uri)) ?? false;
  }

  private release(avatar: Avatar): void {
    this.group.remove(avatar.sprite);
    this.group.remove(avatar.frame);
    if (avatar.halo) this.group.remove(avatar.halo);
    avatar.material.dispose();
    avatar.frameMaterial.map?.dispose();
    avatar.frameMaterial.dispose();
    avatar.haloMaterial?.map?.dispose();
    avatar.haloMaterial?.dispose();
    avatar.texture.dispose();
  }

  /** Releases every avatar and cached portrait. */
  dispose(): void {
    this.disposed = true;
    this.offFrame?.();
    this.offRelease?.();
    this.offFrame = null;
    this.offRelease = null;
    for (const a of this.avatars) this.release(a);
    this.avatars.length = 0;
    this.layers.clear();
    for (const t of this.portraitCache.values()) t.dispose();
    this.portraitCache.clear();
    this.failedPortraits.clear();
    this.pendingPortraits.clear();
    this.enteredIds.clear();
    this.scene.groups.dynamic.remove(this.group);
  }
}
