import { renewOwnerInvite } from "@ozavo/core";
import { ApiError, handle, notFound } from "../../../../../../../server/context";

/**
 * Convite de dono novo para a empresa cujo dono ainda não entrou; o anterior deixa de valer. O link
 * volta só nesta resposta.
 */
export const POST = handle({ platform: true }, async ({ deps, session, params }) => {
  const result = await renewOwnerInvite(deps.db, session.organizationId, session.userId, params.id ?? "", deps.clock.now());
  if (!result.ok) {
    if (result.reason === "not_found") throw notFound();
    if (result.reason === "owner_active") throw new ApiError(409, "owner_active", "The owner already signed in: there is no invite to renew.");
    throw new ApiError(409, "no_owner_invite", "This company never had an owner invite. Invite the owner from the company's team screen.");
  }
  return { ownerInviteUrl: `${deps.publicUrl}/invite/${result.invite.token}`, ownerInviteExpiresAt: result.invite.expiresAt.toISOString(), email: result.email };
});
