import { Module } from "@nestjs/common";

import { AdminRolesService } from "./admin-roles.service";
import { AdminSectionGuard } from "./guards/admin-section.guard";
import { MoneyAccessGuard } from "./guards/money-access.guard";
import { SuperAdminOnlyGuard } from "./guards/super-admin-only.guard";

@Module({
  providers: [AdminRolesService, AdminSectionGuard, MoneyAccessGuard, SuperAdminOnlyGuard],
  exports: [AdminRolesService, AdminSectionGuard, MoneyAccessGuard, SuperAdminOnlyGuard],
})
export class AdminRolesModule {}
