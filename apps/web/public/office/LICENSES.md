# Tài sản của Virtual Office

Toàn bộ tài sản trong thư mục này do dự án **tự vẽ** bằng mã, không sao chép từ nguồn bên ngoài.

| Tệp              | Nội dung                                                                                          | Nguồn                                         | Giấy phép                                 |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `characters.png` | Nhân vật 16×24, 2 khung mỗi `avatar_key` (`developer`, `analyst`, `tester`, `manager`, `generic`) | `apps/web/scripts/generate-office-assets.mjs` | CC0 1.0 (phát hành vào phạm vi công cộng) |
| `icons.png`      | Biểu tượng trạng thái 8×8, mỗi trạng thái một ô                                                   | cùng script                                   | CC0 1.0                                   |
| `tiles.png`      | Ô nền 16×16: sàn department, sàn CEO Office, sàn Break Room, bàn làm việc                         | cùng script                                   | CC0 1.0                                   |

- Không dùng tài sản, nhân vật hay thương hiệu của `ref/Claude-Office` hoặc dự án khác (research R8).
- Sinh lại tài sản: `node apps/web/scripts/generate-office-assets.mjs`. Kích thước ô và thứ tự khung khớp với
  `apps/web/src/office/renderer-pixi/assets.ts`; đổi một bên phải đổi bên kia.
- Thay bộ tài sản (ví dụ bằng tài sản giấy phép mở khác) chỉ cần giữ nguyên bố cục khung ở `assets.ts`; logic nghiệp vụ
  và `office/state` không đổi (FR-039).
