import {
  APP_PROPERTY_FILE_ROLE,
  APP_PROPERTY_FILE_ROLE_VALUE,
  initialAppProperties,
  SPREADSHEET_MIME_TYPE,
  SPREADSHEET_NAME,
} from '@/domain/sheetContract';

import { GoogleApiError } from './http';
import type { GoogleSession } from './session';

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

const FILE_FIELDS = 'id,name,mimeType,trashed,createdTime,modifiedTime,version,appProperties';

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly trashed: boolean;
  readonly createdTime: string | null;
  readonly modifiedTime: string | null;
  /** Drive's monotonically increasing file version; changes with every edit. */
  readonly version: string | null;
  readonly appProperties: Readonly<Record<string, string>>;
}

function toDriveFile(raw: unknown): DriveFile {
  const file = (raw ?? {}) as Record<string, unknown>;
  if (typeof file.id !== 'string' || file.id === '') {
    throw new GoogleApiError('invalid_response', 200, null);
  }
  const props =
    typeof file.appProperties === 'object' && file.appProperties !== null
      ? Object.fromEntries(
          Object.entries(file.appProperties as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    id: file.id,
    name: typeof file.name === 'string' ? file.name : '',
    mimeType: typeof file.mimeType === 'string' ? file.mimeType : '',
    trashed: file.trashed === true,
    createdTime: typeof file.createdTime === 'string' ? file.createdTime : null,
    modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
    version: typeof file.version === 'string' || typeof file.version === 'number' ? String(file.version) : null,
    appProperties: props,
  };
}

/**
 * Files carrying this app's private role property. With the drive.file scope
 * Drive only returns files this app created (or the user opened with it), so
 * the search is scoped to the app's own OAuth project.
 */
export async function findTaggedSpreadsheets(
  session: GoogleSession,
  options: { readonly trashed: boolean },
): Promise<DriveFile[]> {
  const q = [
    `appProperties has { key='${APP_PROPERTY_FILE_ROLE}' and value='${APP_PROPERTY_FILE_ROLE_VALUE}' }`,
    `mimeType='${SPREADSHEET_MIME_TYPE}'`,
    `trashed=${options.trashed ? 'true' : 'false'}`,
  ].join(' and ');
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    pageSize: '50',
    orderBy: 'createdTime',
    fields: `files(${FILE_FIELDS})`,
  });
  const result = await session.request<{ files?: unknown[] }>({
    method: 'GET',
    url: `${DRIVE_FILES_URL}?${params.toString()}`,
  });
  return (result.files ?? []).map(toDriveFile);
}

export async function getDriveFile(session: GoogleSession, fileId: string): Promise<DriveFile> {
  const raw = await session.request<unknown>({
    method: 'GET',
    url: `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
  });
  return toDriveFile(raw);
}

/**
 * Creates an empty Google Sheets file with the app property set in the same
 * request, so a file can never exist untagged.
 */
export async function createTaggedSpreadsheet(session: GoogleSession): Promise<DriveFile> {
  const raw = await session.request<unknown>({
    method: 'POST',
    url: `${DRIVE_FILES_URL}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    body: {
      name: SPREADSHEET_NAME,
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: initialAppProperties(),
    },
  });
  return toDriveFile(raw);
}

/** Merges the given app properties into the file's existing ones. */
export async function setAppProperties(
  session: GoogleSession,
  fileId: string,
  appProperties: Readonly<Record<string, string>>,
): Promise<DriveFile> {
  const raw = await session.request<unknown>({
    method: 'PATCH',
    url: `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    body: { appProperties },
  });
  return toDriveFile(raw);
}
