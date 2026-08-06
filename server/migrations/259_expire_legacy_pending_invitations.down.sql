-- This security migration intentionally does not restore pending invitations:
-- their old email-only links cannot be made safe retroactively.
SELECT 1;
