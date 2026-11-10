import { DryRunAdapter, type DryRunLog } from './dry-run-log';

/** `workspace.git.push` ở chế độ dry-run: ghi yêu cầu push đã duyệt vào log, không push lên remote thật. */
export class GitPushAdapter extends DryRunAdapter {
  constructor(log: DryRunLog) {
    super(log, 'workspace.git.push');
  }
}
