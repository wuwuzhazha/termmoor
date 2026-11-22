export interface VerifyVsixOptions {
  target?: string;
  expectedName?: string;
  expectedVersion?: string;
  expectedPublisher?: string;
  expectedRepositoryUrl?: string;
}

export interface VerifyVsixResult {
  paths: string[];
  manifest?: Record<string, unknown>;
}

export const REQUIRED_FILES: string[];
export const REQUIRED_SETTINGS: string[];
export const SUPPORTED_TARGETS: string[];
export const DEFAULT_TARGET: string;
export const FORBIDDEN_PACKAGE_NAMES: string[];
export const PACKAGE_NAME: string;
export const PUBLISHER: string;
export const REPOSITORY_URL: string;

export function readZipEntries(buffer: Buffer): Map<string, Buffer>;
export function verifyEntries(
  entries: Map<string, Buffer>,
  options?: VerifyVsixOptions
): VerifyVsixResult;
export function verifyVsix(vsixPath: string, options?: VerifyVsixOptions): VerifyVsixResult;
export function findLatestVsix(directory?: string): string | undefined;
export function parseCliArgs(argv: string[]): { target?: string; file?: string };
