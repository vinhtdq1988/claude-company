import { DryRunAdapter, type DryRunLog } from './dry-run-log';

/** `email.send` ở chế độ dry-run: ghi payload email đã duyệt vào log, không gửi thư thật. */
export class EmailAdapter extends DryRunAdapter {
  constructor(log: DryRunLog) {
    super(log, 'email.send');
  }
}
