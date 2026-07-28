import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { Logger } from '@finalrun/common';

export interface PreparedApp {
  /** Path to the file to upload (the bundle if zipped, or the original file). */
  uploadPath: string;
  /** Filename to send in the multipart form. */
  filename: string;
  /** Size in bytes of uploadPath. */
  size: number;
  /** Whether we created a temp zip the caller must unlink after upload. */
  isTempZip: boolean;
  /** Inferred platform hint based on the input shape, if determinable. */
  platformHint?: 'ios' | 'android';
}

const ACCEPTED_HINT = '.apk, .app.zip, or a .app directory';

/**
 * Resolves a user-provided --app path into something uploadable.
 *
 * iOS simulator builds emit a `.app` directory (a macOS bundle), not a file.
 * Streaming a directory to the cloud fails with EISDIR, so we zip `.app`
 * directories on the fly. Other accepted shapes (`.apk`, `.app.zip`) are
 * passed through untouched.
 *
 * The caller owns cleanup of `uploadPath` when `isTempZip` is true.
 */
export function prepareAppForUpload(appPath: string): PreparedApp {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(appPath);
  } catch {
    throw new Error(`App not found: ${appPath}`);
  }

  if (stat.isDirectory()) {
    const basename = path.basename(appPath);
    if (!basename.toLowerCase().endsWith('.app')) {
      throw new Error(
        `--app must be ${ACCEPTED_HINT}; got directory: ${appPath}`,
      );
    }
    return zipAppBundle(appPath, basename);
  }

  const lower = appPath.toLowerCase();
  if (lower.endsWith('.apk')) {
    return {
      uploadPath: appPath,
      filename: path.basename(appPath),
      size: stat.size,
      isTempZip: false,
      platformHint: 'android',
    };
  }
  if (lower.endsWith('.app.zip')) {
    return {
      uploadPath: appPath,
      filename: path.basename(appPath),
      size: stat.size,
      isTempZip: false,
      platformHint: 'ios',
    };
  }
  if (lower.endsWith('.ipa')) {
    throw new Error(
      `IPA uploads are not supported. Pass an iOS simulator build (.app directory or .app.zip).`,
    );
  }
  throw new Error(
    `--app must be ${ACCEPTED_HINT}; got: ${appPath}`,
  );
}

function zipAppBundle(appPath: string, basename: string): PreparedApp {
  // Place the `.app` folder at the top of the archive so the contents look
  // like Wikipedia.app/Info.plist, matching what the server already accepts
  // for `.app.zip` uploads.
  Logger.i(`Zipping ${basename}...`);
  const start = Date.now();
  const zip = new AdmZip();
  zip.addLocalFolder(appPath, basename);

  // Timestamp keeps an orphaned temp file diagnosable; the random component is
  // what makes concurrent submissions collision-proof (same-millisecond runs
  // would otherwise share one path and corrupt/unlink each other's upload).
  const zipPath = path.join(os.tmpdir(), `finalrun-app-${Date.now()}-${randomUUID()}.zip`);

  // The cleanup scope opens BEFORE writeZip, not after it. Acquisition begins
  // *inside* writeZip — adm-zip does openSync(path,'w') to create the file,
  // then writeSync/closeSync/chmodSync — so a throw partway through leaves a
  // created file that a scope opening after the call could never see. The
  // caller can only release the zip once the path is RETURNED (isTempZip
  // contract), so anything that throws before the return must unlink here.
  // The success path must NOT unlink; unlink of a never-created file is
  // swallowed below, which is what makes the wider scope free.
  try {
    zip.writeZip(zipPath);
    const size = fs.statSync(zipPath).size;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    Logger.i(`Zipped ${basename} in ${elapsed}s`);

    return {
      uploadPath: zipPath,
      filename: `${basename}.zip`,
      size,
      isTempZip: true,
      platformHint: 'ios',
    };
  } catch (error) {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}
