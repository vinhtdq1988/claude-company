import { AVATAR_KEYS, type EmployeeState } from '@claude-company/contracts';

/** Bố cục khung của tài sản trong `public/office/` (khớp scripts/generate-office-assets.mjs). */
export const TILE = 16;
export const CHAR_W = 16;
export const CHAR_H = 24;
export const CHAR_FRAMES = 2;
export const ICON = 8;

/** Thứ tự cột của `icons.png`. */
export const ICON_ORDER: readonly EmployeeState[] = [
  'idle',
  'working',
  'thinking',
  'communicating',
  'meeting',
  'waiting_approval',
  'completed',
  'error_blocked',
  'break',
];

/** Hàng của `characters.png` theo `avatar_key`; khóa lạ dùng `generic`. */
export function avatarRow(avatarKey: string): number {
  const index = AVATAR_KEYS.indexOf(avatarKey as (typeof AVATAR_KEYS)[number]);
  return index >= 0 ? index : AVATAR_KEYS.indexOf('generic');
}

export const ASSET_URLS = {
  characters: '/office/characters.png',
  icons: '/office/icons.png',
  tiles: '/office/tiles.png',
} as const;

/** Chỉ số ô trong `tiles.png`. */
export const TILE_INDEX = { department: 0, ceo_office: 1, break_room: 2, desk: 3 } as const;
