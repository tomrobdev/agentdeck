import { drizzleKitOnScratch } from '#scripts/scratch-db.ts';

const { out } = drizzleKitOnScratch(['push', '--explain']);
console.log(out.trim());
