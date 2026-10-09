import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AdminPermissionLevel, AdminSection, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { PrismaService } from "../prisma/prisma.service";

export const ALL_ADMIN_SECTIONS: AdminSection[] = [
  "dashboard",
  "brands",
  "clippers",
  "campaigns",
  "analytics",
  "tickets",
  "faqs",
  "notifications",
  "team",
  "payouts",
];

export type EffectivePermissions = {
  isSuperAdmin: boolean;
  canSeeMoney: boolean;
  sections: Record<AdminSection, AdminPermissionLevel>;
};

function fullAccess(): Record<AdminSection, AdminPermissionLevel> {
  return Object.fromEntries(ALL_ADMIN_SECTIONS.map((s) => [s, "manage" as const])) as Record<
    AdminSection,
    AdminPermissionLevel
  >;
}

function formatRole(role: {
  id: string;
  name: string;
  canSeeMoney: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: { section: AdminSection; level: AdminPermissionLevel }[];
  _count: { users: number };
}) {
  const permissionMap = Object.fromEntries(role.permissions.map((p) => [p.section, p.level])) as Partial<
    Record<AdminSection, AdminPermissionLevel>
  >;
  return {
    id: role.id,
    name: role.name,
    canSeeMoney: role.canSeeMoney,
    userCount: role._count.users,
    permissions: ALL_ADMIN_SECTIONS.map((section) => ({
      section,
      level: permissionMap[section] ?? "hidden",
    })),
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

const roleInclude = {
  permissions: { select: { section: true, level: true } },
  _count: { select: { users: true } },
} as const;

@Injectable()
export class AdminRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async listRoles() {
    const [roles, superAdminCount] = await Promise.all([
      this.prisma.adminRole.findMany({ include: roleInclude, orderBy: { createdAt: "asc" } }),
      this.prisma.user.count({ where: { role: UserRole.admin, adminRoleId: null } }),
    ]);
    return {
      superAdmin: { userCount: superAdminCount },
      roles: roles.map(formatRole),
    };
  }

  async createRole(dto: { name: string; canSeeMoney?: boolean }) {
    const role = await this.prisma.adminRole
      .create({
        data: {
          name: dto.name.trim(),
          canSeeMoney: dto.canSeeMoney ?? false,
          permissions: {
            create: ALL_ADMIN_SECTIONS.map((section) => ({ section, level: AdminPermissionLevel.hidden })),
          },
        },
        include: roleInclude,
      })
      .catch((e) => {
        if (e.code === "P2002") {
          throw new ConflictException({ code: "CONFLICT", message: "A role with this name already exists" });
        }
        throw e;
      });
    return formatRole(role);
  }

  async updateRole(id: string, dto: { name?: string; canSeeMoney?: boolean }) {
    const role = await this.prisma.adminRole
      .update({
        where: { id },
        data: { name: dto.name?.trim(), canSeeMoney: dto.canSeeMoney },
        include: roleInclude,
      })
      .catch((e) => {
        if (e.code === "P2002") {
          throw new ConflictException({ code: "CONFLICT", message: "A role with this name already exists" });
        }
        if (e.code === "P2025") {
          throw new NotFoundException({ code: "NOT_FOUND", message: "Role not found" });
        }
        throw e;
      });
    return formatRole(role);
  }

  async deleteRole(id: string) {
    await this.prisma.adminRole.delete({ where: { id } }).catch(() => {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Role not found" });
    });
    return { deleted: true };
  }

  async setSectionPermissions(roleId: string, permissions: { section: AdminSection; level: AdminPermissionLevel }[]) {
    const role = await this.prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Role not found" });
    }
    await this.prisma.$transaction(
      permissions.map((p) =>
        this.prisma.adminSectionPermission.upsert({
          where: { adminRoleId_section: { adminRoleId: roleId, section: p.section } },
          create: { adminRoleId: roleId, section: p.section, level: p.level },
          update: { level: p.level },
        }),
      ),
    );
    const updated = await this.prisma.adminRole.findUniqueOrThrow({ where: { id: roleId }, include: roleInclude });
    return formatRole(updated);
  }

  /** Sets every role back to hidden-everything / can't-see-money — the
   * safest baseline, since we have no product-defined "default" set of
   * permissions to restore instead. */
  async resetToDefaults() {
    await this.prisma.$transaction([
      this.prisma.adminRole.updateMany({ data: { canSeeMoney: false } }),
      this.prisma.adminSectionPermission.updateMany({ data: { level: AdminPermissionLevel.hidden } }),
    ]);
    return this.listRoles();
  }

  async assignRole(userId: string, adminRoleId: string | null) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== UserRole.admin) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Admin not found" });
    }
    if (adminRoleId) {
      const role = await this.prisma.adminRole.findUnique({ where: { id: adminRoleId } });
      if (!role) {
        throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Role not found" });
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { adminRoleId } });
    return { id: userId, adminRoleId };
  }

  async createAdminAccount(dto: { name: string; email: string; password: string; adminRoleId?: string | null }) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException({ code: "CONFLICT", message: "Email already registered" });
    }
    if (dto.adminRoleId) {
      const role = await this.prisma.adminRole.findUnique({ where: { id: dto.adminRoleId } });
      if (!role) {
        throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Role not found" });
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        role: UserRole.admin,
        email,
        passwordHash,
        displayName: dto.name.trim(),
        adminRoleId: dto.adminRoleId ?? null,
        termsAcceptedAt: new Date(),
      },
      include: { adminRole: { select: { name: true } } },
    });
    return {
      id: user.id,
      name: user.displayName ?? user.email ?? "Admin",
      email: user.email,
      adminRoleId: user.adminRoleId,
      adminRoleName: user.adminRole?.name ?? "Super Admin",
    };
  }

  async listAdminAccounts() {
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.admin },
      select: {
        id: true,
        displayName: true,
        email: true,
        adminRoleId: true,
        adminRole: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return admins.map((a) => ({
      id: a.id,
      name: a.displayName ?? a.email ?? "Admin",
      email: a.email,
      adminRoleId: a.adminRoleId,
      adminRoleName: a.adminRole?.name ?? "Super Admin",
    }));
  }

  async getEffectivePermissions(userId: string): Promise<EffectivePermissions> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { adminRole: { include: { permissions: true } } },
    });
    if (!user || !user.adminRoleId || !user.adminRole) {
      return { isSuperAdmin: true, canSeeMoney: true, sections: fullAccess() };
    }
    const sections = Object.fromEntries(
      ALL_ADMIN_SECTIONS.map((section) => {
        const match = user.adminRole!.permissions.find((p) => p.section === section);
        return [section, match?.level ?? AdminPermissionLevel.hidden];
      }),
    ) as Record<AdminSection, AdminPermissionLevel>;
    return { isSuperAdmin: false, canSeeMoney: user.adminRole.canSeeMoney, sections };
  }
}
