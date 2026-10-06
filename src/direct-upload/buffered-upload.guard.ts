import { CanActivate, GoneException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../config/env";
import { ObjectStorageService } from "../storage/object-storage.service";

/**
 * Closes the website's old "send the file through the API" upload routes
 * whenever R2 is configured, so no browser upload can put file bytes through
 * the API server (Railway) — they go via /uploads/direct instead.
 *
 * A guard, not a check in the handler: guards run BEFORE the multer
 * interceptor, so a refused request is never buffered into memory at all.
 * Without R2 (local dev) the old routes keep working. Mobile-app routes are
 * never decorated with this guard.
 *
 * ALLOW_BUFFERED_WEB_UPLOADS=true re-opens them — a rollout escape hatch if
 * the API ships before the new website build.
 */
@Injectable()
export class BufferedUploadGuard implements CanActivate {
  constructor(
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  canActivate(): boolean {
    if (!this.storage.isR2Configured()) return true;
    if (this.config.get("ALLOW_BUFFERED_WEB_UPLOADS", { infer: true })) return true;
    throw new GoneException({
      code: "USE_DIRECT_UPLOAD",
      message: "Uploads now go straight to storage — please refresh the page and try again.",
    });
  }
}
