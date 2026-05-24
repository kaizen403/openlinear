# OpenLinear — Future Plan (Deferred Work)

Issues and features identified but deferred for later implementation.

---

## Deferred: Email Invites for Team Members

### Context
Currently, the invite flow only supports copying an invite link. We intentionally removed email invites from the initial scope to keep the implementation focused on link-based invites and the web accept page.

### What We Want Later
- User enters comma-separated email addresses in the "Email invites" input
- Click "Send invites" → backend sends actual invitation emails
- Emails contain a branded HTML email with the invite link (`https://openlinear.tech/invite?code=KT-ABC123`)
- Track which emails were sent, opened, clicked
- Resend / cancel pending invites

### Requirements

1. **Email Service Integration**
   - Add email provider (Resend, SendGrid, AWS SES, or self-hosted SMTP)
   - Add environment variables for email config
   - Create email templates (React Email or similar)

2. **Backend Changes**
   - Extend `Invitation` model to track email addresses:
     ```prisma
     model Invitation {
       id         String   @id @default(uuid())
       teamId     String
       team       Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
       code       String   @unique
       email      String?   // ← added for email invites
       status     String   @default("pending") // pending, sent, accepted, expired
       sentAt     DateTime? // ← added
       expiresAt  DateTime @default(dbgenerated("now() + interval '7 days'"))
       createdAt  DateTime @default(now())
       acceptedAt DateTime?
       acceptedBy User?    @relation(fields: [acceptedById], references: [id])
       acceptedById String?
     }
     ```
   - Add `POST /api/teams/:id/invite-by-email` endpoint
   - Validate email list, create invitations, queue email sending
   - Rate-limit: max 20 invites per team per hour

3. **Email Template**
   - Branded OpenLinear HTML email
   - Team name, inviter name/avatar
   - Clear CTA button: "Join Team on OpenLinear"
   - Link expires in 7 days
   - Plain-text fallback

4. **Frontend Changes**
   - In `InviteStep` (onboarding-wizard.tsx):
     - Keep the "Email invites" input
     - Replace the mailto/draft email behavior with a "Send invites" button
     - Show loading state while sending
     - Show success/error toast per email
     - Show list of pending invites with resend option
   - In team management page (`apps/desktop-ui/app/(app)/teams/manage/page.tsx`):
     - Add "Invites" tab showing pending/sent/accepted invites
     - Allow resending or revoking pending invites

5. **Tracking & Notifications**
   - Track email open rates (pixel tracking optional)
   - Track link clicks
   - Send notification to inviter when invitee accepts
   - Expired invites auto-cleanup (daily cron)

### Files to Modify (when implemented)
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — wire up actual email sending
- `apps/api/src/routes/teams.ts` — add invite-by-email endpoint
- `packages/db/prisma/schema.prisma` — extend Invitation model
- `apps/api/src/services/email.ts` — new email service (create this file)
- `apps/api/src/emails/` — email templates directory
- `apps/desktop-ui/app/(app)/teams/manage/page.tsx` — add invites management UI

### Effort Estimate
Medium — requires email provider setup, template design, backend queue/worker for sending, and frontend UI for managing invites.

---
