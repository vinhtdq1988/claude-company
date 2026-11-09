import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMountPath } from '../src/engines/employee/workspace.service';

describe('resolveMountPath (T072: mount_path nằm trong WORKSPACE_HOST_PATH)', () => {
  const root = path.resolve('data-test', 'workspaces');

  it('đường dẫn tương đối được hiểu từ thư mục gốc và chuẩn hóa', () => {
    expect(resolveMountPath(root, 'repo')).toBe(path.join(root, 'repo'));
    expect(resolveMountPath(root, './a/../repo/')).toBe(path.join(root, 'repo'));
  });

  it('đường dẫn tuyệt đối nằm trong gốc được chấp nhận', () => {
    expect(resolveMountPath(root, path.join(root, 'docs'))).toBe(path.join(root, 'docs'));
  });

  it('từ chối thoát ra ngoài, chính thư mục gốc, thư mục anh em có tiền tố giống và byte NUL', () => {
    expect(resolveMountPath(root, '../ngoai')).toBeNull();
    expect(resolveMountPath(root, 'a/../../ngoai')).toBeNull();
    expect(resolveMountPath(root, '.')).toBeNull();
    expect(resolveMountPath(root, path.resolve(root, '..'))).toBeNull();
    expect(resolveMountPath(root, `${root}-evil/repo`)).toBeNull();
    expect(resolveMountPath(root, 'repo\0x')).toBeNull();
  });
});
