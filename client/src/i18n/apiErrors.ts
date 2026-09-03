import type { Locale } from './types';
import { translate } from './core';

/** Stały komunikat — mapowany w UI na auth.apiUnreachable (brak backendu / błąd proxy Vite). */
export const API_UNREACHABLE_MESSAGE = '__CAPACITY_API_UNREACHABLE__';

/** Mapowanie komunikatów z API (głównie PL z serwera) na klucze i18n. */
const ERROR_KEY_BY_MESSAGE: Record<string, string> = {
  [API_UNREACHABLE_MESSAGE]: 'auth.apiUnreachable',
  'Operation not found': 'errors.operationNotFound',
  'Not found': 'errors.notFound',
  'Invalid id': 'errors.invalidId',
  'sap_number is required': 'errors.sapNumberRequired',
  'type is required': 'errors.typeRequired',
  'Machine number already exists': 'errors.machineNumberExists',
  'Machine cannot be alternative to itself': 'errors.altSelf',
  'Alternative already added': 'errors.altAlreadyAdded',
  'Parametr operationId jest wymagany.': 'errors.operationIdRequired',
  'Set musi zawierać co najmniej 2 detale.': 'errors.setMinTwoParts',
  'Dla setu wybierz detal źródłowy wolumenu.': 'errors.setVolumeSource',
  'Detal źródłowy wolumenu musi należeć do setu.': 'errors.setVolumeSourceInSet',
  'Wybierz maszynę z listy — pole „Maszyna” jest wymagane.': 'errors.machineRequired',
  'Wybrana maszyna nie istnieje w bazie. Wybierz maszynę z listy.': 'errors.machineNotFound',
  'Operacja nie ma zdefiniowanego alternatywnego czasu cyklu.': 'errors.noAltCycle',
  'Dla wybranego roku wolumen tej operacji wynosi 0.': 'errors.volumeZeroYear',
  'Wolumen musi być dodatni.': 'errors.volumeMustBePositive',
  'Wolumen do przeniesienia przekracza wolumen operacji dla wybranego roku.': 'errors.volumeExceedsOperation',
  'Scenariusz nie znaleziony': 'errors.scenarioNotFound',
  'Nazwa scenariusza jest wymagana': 'errors.scenarioNameRequired',
  'Podaj zakres scenariusza (wymagane pole tekstowe).': 'errors.scenarioScopeRequired',
  'Wybierz scenariusz źródłowy': 'errors.scenarioSourceRequired',
  'Nie udało się wczytać scenariuszy': 'errors.scenariosLoadFailed',
  'Nie udało się pobrać historii zmian.': 'errors.historyLoadFailed',
  'Nie udało się dodać detalu': 'errors.designationAddFailed',
  'Detal o takim oznaczeniu już istnieje i nie został utworzony kolejny': 'designations.duplicateExistsModal',
  'Detal o takim oznaczeniu już istnieje': 'designations.duplicateExistsModal',
  'Nie udało się zapisać': 'errors.saveFailed',
  'Błąd ładowania detali': 'errors.designationsLoadFailed',
  'Błąd ładowania listy maszyn.': 'errors.machinesLoadFailed',
  'Błąd ładowania listy projektów.': 'errors.projectsLoadFailed',
  'Podaj numer SAP': 'errors.provideSap',
  'Podaj klienta': 'errors.provideClient',
  'Podaj nazwę projektu': 'errors.provideProjectName',
  'Podaj typ maszyny z listy.': 'errors.provideMachineType',
  'Podaj typ maszyny lub zdefiniuj typy w Administracja → Ustawienia bazy → Typy maszyn.': 'errors.provideMachineTypeOrAdmin',
  'Podaj numer linii (tylko cyfry, liczba całkowita)': 'errors.provideLineNumber',
  'Machine usage musi być liczbą z zakresu 0..1': 'errors.machineUsageRange',
  'FOREIGN KEY constraint failed': 'errors.machineRequired',
  'File is password-protected': 'admin.ocuDataFilePasswordProtected',
  'Plik Katowice_Data jest zaszyfrowany hasłem otwarcia. Podaj hasło w polu poniżej (nie da się go ominąć bez hasła).':
    'admin.ocuDataFilePasswordProtected',
  'Nie udało się odszyfrować pliku — sprawdź hasło otwarcia Katowice_Data.': 'admin.ocuDataFilePasswordWrong',
};

const PREFIX_RULES: { prefix: string; key: string }[] = [
  { prefix: 'Rok ', key: 'errors.yearVolumeTooLarge' },
  { prefix: 'Dla lat ', key: 'errors.yearsVolumeZero' },
  { prefix: 'Operacja nie występuje w latach:', key: 'errors.operationMissingYears' },
  { prefix: 'Dla roku ', key: 'errors.yearVolumeTooLargeShort' },
];

export function translateApiError(locale: Locale, message: string | undefined | null): string {
  const raw = String(message ?? '').trim();
  if (!raw) return translate(locale, 'common.error');
  const exact = ERROR_KEY_BY_MESSAGE[raw];
  if (exact) return translate(locale, exact);
  if (raw.includes('FOREIGN KEY')) return translate(locale, 'errors.machineRequired');
  for (const { prefix, key } of PREFIX_RULES) {
    if (raw.startsWith(prefix)) return translate(locale, key, { detail: raw });
  }
  if (raw.toLowerCase().includes('password-protected') || raw.toLowerCase().includes('password protected')) {
    return translate(locale, 'admin.ocuDataFilePasswordProtected');
  }
  return raw;
}
