UPDATE workspace_invitation
SET status = 'expired', updated_at = now()
WHERE status = 'pending';
