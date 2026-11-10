import { DryRunAdapter, type DryRunLog } from './dry-run-log';

/** `data.delete` ở chế độ dry-run: ghi yêu cầu xóa đã duyệt vào log, không xóa dữ liệu thật. */
export class DataDeleteAdapter extends DryRunAdapter {
  constructor(log: DryRunLog) {
    super(log, 'data.delete');
  }
}
