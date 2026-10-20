export interface User {
  id: string;
  role: Role;
}

export type Role = "admin" | "member";

export enum Status {
  Active,
  Disabled,
}
