import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  type Ticker,
} from 'pixi.js';
import type { EmployeeState, OfficeSnapshot } from '@claude-company/contracts';
import { ANIMATED_STATES, officeBounds, placeEmployees } from '../state/placement';
import {
  ASSET_URLS,
  avatarRow,
  CHAR_FRAMES,
  CHAR_H,
  CHAR_W,
  ICON,
  ICON_ORDER,
  TILE,
  TILE_INDEX,
} from './assets';

const ZONE_BORDER: Record<string, number> = {
  department: 0x6b7a99,
  ceo_office: 0xb08a4b,
  break_room: 0x4f9d7a,
};

type CharacterView = {
  root: Container;
  sprite: Sprite;
  icon: Sprite;
  baseY: number;
  state: EmployeeState;
  avatarKey: string;
};

type Textures = {
  characters: Texture[][];
  icons: Texture[];
  tiles: Texture[];
};

/**
 * Renderer PixiJS 8 (T161). Chỉ nhận `OfficeSnapshot` và phát `onSelectEmployee`; không biết gì về realtime, store hay
 * quy tắc nghiệp vụ nên có thể thay bằng renderer khác (FR-039). Animation chỉ chạy khi trạng thái đang hoạt động
 * (không có chuyển động "trang trí" tự bịa); nhân vật `idle`, `completed`, `break` đứng yên.
 */
export class OfficeRenderer {
  private app: Application | undefined;
  private world = new Container();
  private textures: Textures | undefined;
  private characters = new Map<string, CharacterView>();
  private snapshot: OfficeSnapshot | undefined;
  private stale = false;
  private selectHandler: ((employeeId: string) => void) | undefined;
  private elapsedMs = 0;
  private host: HTMLElement | undefined;
  private resizeObserver: ResizeObserver | undefined;

  onSelectEmployee(handler: (employeeId: string) => void): void {
    this.selectHandler = handler;
  }

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: 0x1d2330,
      antialias: false,
      roundPixels: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    host.appendChild(app.canvas);
    app.stage.addChild(this.world);
    this.app = app;
    this.textures = await this.loadTextures();
    app.ticker.add((ticker) => this.animate(ticker));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(host);
    if (this.snapshot) this.render();
  }

  /** Vẽ lại theo snapshot mới nhất; `stale` làm mờ cả văn phòng ("Trạng thái có thể đã cũ"). */
  update(snapshot: OfficeSnapshot, options: { stale: boolean }): void {
    this.snapshot = snapshot;
    this.stale = options.stale;
    if (this.textures) this.render();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.app?.destroy({ removeView: true }, { children: true });
    this.app = undefined;
    this.characters.clear();
    this.textures = undefined;
  }

  private async loadTextures(): Promise<Textures> {
    const [characters, icons, tiles] = await Promise.all([
      Assets.load<Texture>(ASSET_URLS.characters),
      Assets.load<Texture>(ASSET_URLS.icons),
      Assets.load<Texture>(ASSET_URLS.tiles),
    ]);
    // Pixel art: phóng to theo láng giềng gần nhất, không làm mờ.
    for (const texture of [characters, icons, tiles]) texture.source.scaleMode = 'nearest';
    const slice = (base: Texture, x: number, y: number, w: number, h: number) =>
      new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) });
    const rows = Math.round(characters.height / CHAR_H);
    return {
      characters: Array.from({ length: rows }, (_, row) =>
        Array.from({ length: CHAR_FRAMES }, (_, f) =>
          slice(characters, f * CHAR_W, row * CHAR_H, CHAR_W, CHAR_H),
        ),
      ),
      icons: ICON_ORDER.map((_, i) => slice(icons, i * ICON, 0, ICON, ICON)),
      tiles: Array.from({ length: 4 }, (_, i) => slice(tiles, i * TILE, 0, TILE, TILE)),
    };
  }

  /** Dựng lại cảnh từ snapshot: zone, bàn, nhân vật. */
  private render(): void {
    const { snapshot, textures } = this;
    if (!snapshot || !textures || !this.app) return;

    // Dựng lại toàn cảnh mỗi lần: ≤ ~20 nhân vật nên rẻ; texture dùng chung không bị hủy.
    for (const child of this.world.removeChildren()) child.destroy({ children: true });
    this.characters.clear();

    const scene = new Container();
    this.world.addChild(scene);

    for (const zone of snapshot.zones) {
      const { x, y, cols, rows } = zone.layout;
      const floor = new Graphics()
        .rect(x * TILE, y * TILE, cols * TILE, rows * TILE)
        .fill({ color: 0xdfe6f1 })
        .stroke({ width: 2, color: ZONE_BORDER[zone.kind] ?? 0x6b7a99 });
      scene.addChild(floor);
      const tile = textures.tiles[TILE_INDEX[zone.kind]];
      if (tile) {
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            const sprite = new Sprite(tile);
            sprite.position.set((x + c) * TILE, (y + r) * TILE);
            scene.addChild(sprite);
          }
        }
      }
      const label = new Text({
        text: zone.name,
        style: { fontSize: 8, fill: 0x2b3345, fontFamily: 'monospace', fontWeight: 'bold' },
      });
      label.position.set(x * TILE + 4, y * TILE + 3);
      scene.addChild(label);
    }

    const desk = textures.tiles[TILE_INDEX.desk];
    const placements = placeEmployees(snapshot);
    for (const p of placements) {
      if (!desk) break;
      const sprite = new Sprite(desk);
      sprite.position.set(p.desk.col * TILE, p.desk.row * TILE);
      scene.addChild(sprite);
    }

    for (const p of placements) {
      const employee = snapshot.employees.find((e) => e.id === p.employeeId);
      if (!employee) continue;
      const root = new Container();
      const baseY = p.stand.row * TILE - (CHAR_H - TILE);
      root.position.set(p.stand.col * TILE, baseY);
      root.eventMode = 'static';
      root.cursor = 'pointer';
      root.hitArea = new Rectangle(0, 0, CHAR_W, CHAR_H);
      root.on('pointertap', () => this.selectHandler?.(employee.id));

      const frames = textures.characters[avatarRow(employee.avatarKey)] ?? textures.characters[0];
      const sprite = new Sprite(frames?.[0]);
      root.addChild(sprite);
      const iconIndex = ICON_ORDER.indexOf(employee.state);
      const icon = new Sprite(textures.icons[iconIndex] ?? textures.icons[0]);
      icon.position.set(CHAR_W - 4, -ICON + 2);
      icon.visible = employee.state !== 'idle';
      root.addChild(icon);
      const name = new Text({
        text: employee.name,
        style: { fontSize: 7, fill: 0x1b1f2a, fontFamily: 'monospace' },
      });
      name.anchor.set(0.5, 0);
      name.position.set(CHAR_W / 2, CHAR_H + 1);
      root.addChild(name);

      scene.addChild(root);
      this.characters.set(employee.id, {
        root,
        sprite,
        icon,
        baseY,
        state: employee.state,
        avatarKey: employee.avatarKey,
      });
    }

    scene.alpha = this.stale ? 0.55 : 1;
    this.fit();
  }

  /** Co giãn cả văn phòng vừa khung nhìn, giữ tỉ lệ ô nguyên để pixel art sắc nét. */
  private fit(): void {
    const { app, snapshot, host } = this;
    if (!app || !snapshot || !host) return;
    const bounds = officeBounds(snapshot.zones);
    const width = bounds.cols * TILE;
    const height = bounds.rows * TILE;
    const scale = Math.max(
      1,
      Math.floor(Math.min(host.clientWidth / width, host.clientHeight / height)),
    );
    this.world.scale.set(scale);
    this.world.position.set(
      Math.round((host.clientWidth - width * scale) / 2),
      Math.round((host.clientHeight - height * scale) / 2),
    );
  }

  private animate(ticker: Ticker): void {
    this.elapsedMs += ticker.deltaMS;
    const frame = Math.floor(this.elapsedMs / 250) % CHAR_FRAMES;
    const textures = this.textures;
    if (!textures) return;
    for (const view of this.characters.values()) {
      if (!ANIMATED_STATES.has(view.state)) continue;
      const frames = textures.characters[avatarRow(view.avatarKey)];
      const texture = frames?.[frame];
      if (texture) view.sprite.texture = texture;
      // Biểu tượng chờ duyệt/lỗi nhấp nháy để thu hút chú ý; các trạng thái làm việc giữ cố định.
      if (view.state === 'waiting_approval' || view.state === 'error_blocked') {
        view.icon.visible = frame === 0;
      }
    }
  }
}
