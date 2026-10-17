import type { FastifyPluginCallback, FastifyReply } from "fastify";
import {
  deleteUser,
  disableUser,
  enableUser,
  listUsers,
  setAdmin,
  setPassword,
  type AdminUser,
} from "../auth/admin.js";
import { passwordProblem } from "../auth/credentials.js";
import { isRecord, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface AdminUserListResponse {
  users: AdminUser[];
}

// A user id from the path, or null for anything that cannot be one.
function parseUserId(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function notFound(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "user not found");
}

// /admin/users: list accounts, disable and enable them, set a password,
// grant and revoke the admin role, delete. Registered behind requireUser and
// requireAdmin. Every change is idempotent and answers the account as it now
// is, except delete, which answers 204 and then 404. An admin cannot
// disable, delete or revoke their own account, so there is always at least
// the acting admin left.
export const adminUserRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("admin users"));

  app.get("/admin/users", async (): Promise<AdminUserListResponse> => {
    return { users: await listUsers(db) };
  });

  // The actions that take no body, and whether the caller may aim them at
  // their own account.
  const actions: {
    path: string;
    selfAllowed: boolean;
    run: (id: number) => Promise<AdminUser | null>;
  }[] = [
    {
      path: "disable",
      selfAllowed: false,
      // Also ends the account's sessions.
      run: (id) => disableUser(db, id),
    },
    { path: "enable", selfAllowed: true, run: (id) => enableUser(db, id) },
    {
      path: "grant-admin",
      selfAllowed: true,
      run: (id) => setAdmin(db, id, true),
    },
    {
      path: "revoke-admin",
      selfAllowed: false,
      run: (id) => setAdmin(db, id, false),
    },
  ];

  for (const action of actions) {
    app.post<{ Params: { id: string } }>(
      `/admin/users/:id/${action.path}`,
      async (request, reply) => {
        const id = parseUserId(request.params.id);
        if (id === null) return notFound(reply);
        if (!action.selfAllowed && id === request.user!.id) {
          return refuseSelf(reply, action.path);
        }
        const updated = await action.run(id);
        if (!updated) return notFound(reply);
        request.log.info(
          { adminId: request.user!.id, userId: id, action: action.path },
          "admin users: changed",
        );
        return updated;
      },
    );
  }

  // { password }: the account's new password, usable at once.
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/admin/users/:id/password",
    async (request, reply) => {
      const id = parseUserId(request.params.id);
      if (id === null) return notFound(reply);
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.password !== "string") {
        return sendError(
          reply,
          400,
          "invalid_request",
          "password must be a string",
        );
      }
      const problem = passwordProblem(body.password);
      if (problem !== null) {
        return sendError(reply, 400, "invalid_request", problem);
      }
      const updated = await setPassword(db, id, body.password);
      if (!updated) return notFound(reply);
      request.log.info(
        { adminId: request.user!.id, userId: id, action: "set-password" },
        "admin users: changed",
      );
      return updated;
    },
  );

  // Deletes the account, its sessions and its recipes. 204, then 404.
  app.delete<{ Params: { id: string } }>(
    "/admin/users/:id",
    async (request, reply) => {
      const id = parseUserId(request.params.id);
      if (id === null) return notFound(reply);
      if (id === request.user!.id) return refuseSelf(reply, "delete");
      if (!(await deleteUser(db, id))) return notFound(reply);
      request.log.info(
        { adminId: request.user!.id, userId: id, action: "delete" },
        "admin users: changed",
      );
      return reply.code(204).send();
    },
  );

  done();
};

function refuseSelf(reply: FastifyReply, action: string) {
  return sendError(
    reply,
    409,
    "cannot_change_own_account",
    `an admin cannot ${action.replace("-", " ")} their own account`,
  );
}
