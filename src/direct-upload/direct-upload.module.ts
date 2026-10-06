import { Module } from "@nestjs/common";

import { AccessModule } from "../access/access.module";
import { AdminRolesModule } from "../admin-roles/admin-roles.module";
import { ParticipationModule } from "../participation/participation.module";
import { StorageModule } from "../storage/storage.module";
import { DirectUploadController } from "./direct-upload.controller";
import { DirectUploadService } from "./direct-upload.service";

@Module({
  imports: [StorageModule, AccessModule, AdminRolesModule, ParticipationModule],
  controllers: [DirectUploadController],
  providers: [DirectUploadService],
})
export class DirectUploadModule {}
