import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { initDb, saveDb } from './db/connection.js';
import { bootstrapAuthIfEmpty, forceResetBootstrapAdminPassword } from './auth/userService.js';
import { optionalAuth, requireAuth, requirePermissionForResource, requireAdminAccess, enforceProjectMutationScope } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { usersAdminRouter, rolesAdminRouter } from './routes/usersAdmin.js';
import { settingsRouter, phasesRouter, designationsRouter, machineTypesRouter } from './routes/settings.js';
import { machinesRouter } from './routes/machines.js';
import { machineGroupsRouter } from './routes/machineGroups.js';
import { nestsRouter } from './routes/nests.js';
import { alternativesRouter } from './routes/alternatives.js';
import { projectsRouter } from './routes/projects.js';
import { capacityRouter } from './routes/capacity.js';
import { allocationRouter } from './routes/allocation.js';
import { scenariosRouter } from './routes/scenarios.js';
import { callOffsRouter } from './routes/callOffs.js';
import { adminRouter, startAdminBackupScheduler } from './routes/admin.js';

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'X-Capacity-Data-Import-Schema', 'X-OCU-Stats'],
  }),
);
app.use(compression({ threshold: 1024 }));
app.use(express.json());

app.use(optionalAuth);

app.use('/api/auth', authRouter);
app.use('/api/admin/users', usersAdminRouter);
app.use('/api/admin/roles', rolesAdminRouter);

app.use('/api/settings/phases', requireAuth, requirePermissionForResource('admin_database'), phasesRouter);
app.use('/api/settings/designations', requireAuth, requirePermissionForResource('designations'), designationsRouter);
app.use('/api/settings/machine-types', requireAuth, requirePermissionForResource('admin_database'), machineTypesRouter);
app.use('/api/settings', requireAuth, requirePermissionForResource('admin_settings'), settingsRouter);
app.use('/api/machines', requireAuth, requirePermissionForResource('machines'), machinesRouter);
app.use('/api/machine-groups', requireAuth, requirePermissionForResource('machines'), machineGroupsRouter);
app.use('/api/nests', requireAuth, requirePermissionForResource('machines'), nestsRouter);
app.use('/api/alternatives', requireAuth, requirePermissionForResource('machines'), alternativesRouter);
app.use('/api/projects', requireAuth, requirePermissionForResource('projects'), enforceProjectMutationScope, projectsRouter);
app.use('/api/capacity', requireAuth, requirePermissionForResource('calculator'), capacityRouter);
app.use('/api/allocation', requireAuth, requirePermissionForResource('projects'), allocationRouter);
app.use('/api/scenarios', requireAuth, requirePermissionForResource('scenarios'), scenariosRouter);
app.use('/api/call-offs', requireAuth, requirePermissionForResource('call_offs'), callOffsRouter);
app.use('/api/admin', requireAuth, requireAdminAccess, adminRouter);

function resolveClientDist(): string | null {
  const fromEnv = process.env.CLIENT_DIST?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const sibling = path.resolve(process.cwd(), '..', 'client', 'dist');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function mountClientStatic(): void {
  const clientDist = resolveClientDist();
  if (!clientDist) return;
  console.log(`[capacity] Serving static UI from ${clientDist}`);
  const isProd = process.env.NODE_ENV === 'production';
  app.use(
    '/assets',
    express.static(path.join(clientDist, 'assets'), {
      maxAge: isProd ? '1y' : 0,
      immutable: isProd,
      etag: true,
      lastModified: true,
    })
  );
  app.use(
    express.static(clientDist, {
      index: false,
      maxAge: isProd ? '1h' : 0,
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

mountClientStatic();

/**
 * Siatka bezpieczeństwa — bez tego jakikolwiek nieobsłużony wyjątek w trasie/middleware (w tym błąd
 * multera rzucony poza specyficznymi handlerami trasy) trafia do domyślnego handlera Express, który
 * odpowiada gołym „Internal Server Error” (HTML, bez JSON) — klient nie ma się czego uchwycić.
 * Musi być zarejestrowany jako OSTATNI middleware.
 */
const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Plik jest za duży (limit dla tego importu). Zmniejsz plik i spróbuj ponownie.' });
      return;
    }
    res.status(400).json({ error: `Błąd wgrywania pliku (${err.code}): ${err.message}` });
    return;
  }
  console.error('[capacity] Nieobsłużony błąd serwera:', err);
  res.status(500).json({ error: err?.message || 'Nieoczekiwany błąd serwera.' });
};
app.use(globalErrorHandler);

/** Log bez ubijania procesu — lepiej zwrócić 500 na jednym żądaniu niż zrestartować cały serwer. */
process.on('unhandledRejection', (reason) => {
  console.error('[capacity] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[capacity] Uncaught exception:', err);
});

const PORT = process.env.PORT || 3001;

async function main() {
  await initDb();
  await bootstrapAuthIfEmpty();
  await forceResetBootstrapAdminPassword();
  saveDb();
  setInterval(saveDb, 3000);
  startAdminBackupScheduler();
  process.on('beforeExit', saveDb);
  const server = app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[capacity] Port ${PORT} jest zajęty — TEN proces się nie uruchomił. Nadal działa STARY backend na tym porcie ` +
          `(m.in. stary szablon Excel bez arkusza „Operacje”).\n` +
          `           Zamknij drugie okno terminala z serwerem LUB na Windows:\n` +
          `             netstat -ano | findstr :${PORT}\n` +
          `             taskkill /PID <ostatnia_kolumna_PID> /F\n` +
          `           Potem ponów npm run dev lub npm start w folderze server.\n`,
      );
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
