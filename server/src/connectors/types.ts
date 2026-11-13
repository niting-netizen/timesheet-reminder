import type { SourceConfig } from '../../../shared/settings';
import type { FetchFn } from '../testers/http';

/** One worklog, normalised. `workDate` is the calendar date in the company timezone. */
export interface FetchedWorklog {
  externalId: string;
  externalUserId: string;
  authorName: string;
  issueKey: string;
  project: string;
  workDate: string;
  seconds: number;
}

export interface FetchRange {
  /** Inclusive ISO dates in the company calendar. */
  from: string;
  to: string;
  timezone: string;
}

export interface ConnectorContext {
  fetch: FetchFn;
  allowInsecure: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The source could not supply complete data. Employees who depend on it are not judged. */
export class SourceUnavailable extends Error {}

export interface TimesheetConnector {
  fetchWorklogs(src: SourceConfig, secret: string | undefined, range: FetchRange, ctx: ConnectorContext): Promise<FetchedWorklog[]>;
}
