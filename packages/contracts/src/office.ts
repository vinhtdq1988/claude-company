import type { DomainEvent, EmployeeState } from './realtime';

// Type khung; US5 (T152) thay bằng Zod schema OfficeSnapshot.
export type OfficeSnapshot = {
  seq: number;
  zones: Array<{ id: string; name: string; orgUnitId: string }>;
  employees: Array<{
    id: string;
    name: string;
    avatarKey: string;
    zoneId: string;
    deskIndex: number;
    state: EmployeeState;
    currentTaskId: string | null;
    progress: number | null;
  }>;
};

export type EmployeeStatusChange = {
  employeeId: string;
  state: EmployeeState;
  previousState: EmployeeState;
  sourceEvent: DomainEvent;
};
