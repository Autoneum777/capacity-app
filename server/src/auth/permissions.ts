export type PermissionAction =
  | 'view'
  | 'details'
  | 'change_status'
  | 'edit'
  | 'delete'
  | 'download'
  | 'create_rfq'
  | 'view_confidential';

export type PermissionResource =
  | 'calculator'
  | 'machines'
  | 'projects'
  | 'designations'
  | 'scenarios'
  | 'call_offs'
  | 'admin_database'
  | 'admin_settings'
  | 'admin_data_viz'
  | 'admin_ocu'
  | 'admin_attachments'
  | 'change_history'
  | 'user_management'
  | 'role_management';

export const PERMISSION_MATRIX: Record<PermissionResource, PermissionAction[]> = {
  calculator: ['view', 'download'],
  machines: ['view', 'details', 'change_status', 'edit', 'delete', 'download'],
  projects: ['view', 'details', 'change_status', 'edit', 'delete', 'create_rfq'],
  designations: ['view', 'edit', 'delete', 'download'],
  scenarios: ['view', 'edit', 'delete', 'download', 'view_confidential'],
  call_offs: ['view', 'edit', 'delete', 'download'],
  admin_database: ['view', 'edit', 'download'],
  admin_settings: ['view', 'edit', 'download'],
  admin_data_viz: ['view', 'edit', 'download'],
  admin_ocu: ['view', 'edit'],
  admin_attachments: ['view', 'download'],
  change_history: ['view', 'download'],
  user_management: ['view', 'edit', 'delete'],
  role_management: ['view', 'edit', 'delete'],
};

export function permissionKey(resource: PermissionResource, action: PermissionAction): string {
  return `${resource}.${action}`;
}

export const ALL_PERMISSION_KEYS: string[] = Object.entries(PERMISSION_MATRIX).flatMap(([resource, actions]) =>
  actions.map((action) => permissionKey(resource as PermissionResource, action))
);

export function isValidPermissionKey(key: string): boolean {
  return ALL_PERMISSION_KEYS.includes(key);
}

export function isStatusOnlyBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  return keys.length === 1 && keys[0] === 'status';
}

export function actionForHttpMethod(method: string): PermissionAction {
  const m = method.toUpperCase();
  if (m === 'DELETE') return 'delete';
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') return 'edit';
  return 'view';
}

export function hasPermission(permissions: string[] | undefined, key: string): boolean {
  return Array.isArray(permissions) && permissions.includes(key);
}

/** Pełna edycja projektów vs. tylko projekty RFQ (create_rfq). */
export function canMutateProject(
  permissions: string[] | undefined,
  projectStatus: string | null | undefined
): boolean {
  if (hasPermission(permissions, 'projects.edit')) return true;
  if (hasPermission(permissions, 'projects.create_rfq') && projectStatus === 'RFQ') return true;
  return false;
}

export function canCreateProjectWithStatus(
  permissions: string[] | undefined,
  status: string
): boolean {
  if (hasPermission(permissions, 'projects.edit')) return true;
  if (hasPermission(permissions, 'projects.create_rfq') && status === 'RFQ') return true;
  return false;
}
