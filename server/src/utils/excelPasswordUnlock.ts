import officeCrypto from 'officecrypto-tool';

const PASSWORD_REQUIRED =
  'Plik Katowice_Data jest zaszyfrowany hasłem otwarcia. Podaj hasło w polu poniżej (nie da się go ominąć bez hasła).';
const PASSWORD_WRONG =
  'Nie udało się odszyfrować pliku — sprawdź hasło otwarcia Katowice_Data.';

function looksLikePasswordError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('password') ||
    msg.includes('encrypt') ||
    msg.includes('decrypt') ||
    msg.includes('hasło') ||
    msg.includes('crypto') ||
    msg.includes('incorrect')
  );
}

/** Czy bufor wygląda na zaszyfrowany skoroszyt Office (CFB / Agile). */
export function isExcelFileEncrypted(buffer: Buffer): boolean {
  try {
    return officeCrypto.isEncrypted(buffer) === true;
  } catch {
    return false;
  }
}

async function decryptWithPassword(buffer: Buffer, password: string): Promise<Buffer> {
  const decrypted = await officeCrypto.decrypt(buffer, { password });
  if (!Buffer.isBuffer(decrypted) || decrypted.length < 64) {
    throw new Error(PASSWORD_WRONG);
  }
  return Buffer.from(decrypted);
}

/**
 * Zwraca bufor gotowy do odczytu przez xlsx / OOXML.
 * Hasła otwarcia nie da się „ominąć” — bez poprawnego hasła plik pozostaje nieczytelny.
 */
export async function unlockExcelBufferIfNeeded(
  buffer: Buffer,
  password?: string | null,
  fileLabel = 'Katowice_Data'
): Promise<Buffer> {
  const encrypted = isExcelFileEncrypted(buffer);
  const pwd = String(password ?? '').trim();

  if (!encrypted) {
    // Czasem isEncrypted=false, a SheetJS i tak rzuca „File is password-protected”.
    return buffer;
  }

  if (!pwd) {
    throw new Error(PASSWORD_REQUIRED.replace('Katowice_Data', fileLabel));
  }

  try {
    return await decryptWithPassword(buffer, pwd);
  } catch (e) {
    if (String((e as Error)?.message ?? '') === PASSWORD_WRONG) throw e;
    if (looksLikePasswordError(e)) throw new Error(PASSWORD_WRONG);
    throw new Error(PASSWORD_WRONG);
  }
}

/** Opakowanie XLSX.read z automatycznym odszyfrowaniem przy błędzie hasła. */
export async function readWorkbookBufferWithOptionalPassword(
  buffer: Buffer,
  password?: string | null,
  fileLabel = 'Katowice_Data'
): Promise<Buffer> {
  const pwd = String(password ?? '').trim();
  let unlocked = await unlockExcelBufferIfNeeded(buffer, password, fileLabel);
  try {
    const XLSX = await import('xlsx');
    XLSX.read(unlocked, { type: 'buffer', bookSheets: true });
    return unlocked;
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (!/password/i.test(msg)) throw e;
    if (!pwd) throw new Error(PASSWORD_REQUIRED.replace('Katowice_Data', fileLabel));
    try {
      unlocked = await decryptWithPassword(buffer, pwd);
      const XLSX = await import('xlsx');
      XLSX.read(unlocked, { type: 'buffer', bookSheets: true });
      return unlocked;
    } catch {
      throw new Error(PASSWORD_WRONG);
    }
  }
}
