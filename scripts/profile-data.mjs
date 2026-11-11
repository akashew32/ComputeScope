import { withDatabase, fail } from '../lib/database.mjs';
import { profileData } from '../lib/profile.mjs';
import { saveReceipt } from '../lib/receipts.mjs';

try { await saveReceipt('population-profile', await withDatabase(profileData)); }
catch (error) { fail(error); }
