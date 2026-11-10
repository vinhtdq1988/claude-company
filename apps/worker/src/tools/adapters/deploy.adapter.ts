import { DryRunAdapter, type DryRunLog } from './dry-run-log';

/** `deploy.staging` / `deploy.production` ở chế độ dry-run: ghi yêu cầu deploy đã duyệt, không triển khai thật. */
export class DeployAdapter extends DryRunAdapter {
  constructor(log: DryRunLog, target: 'deploy.staging' | 'deploy.production') {
    super(log, target);
  }
}
