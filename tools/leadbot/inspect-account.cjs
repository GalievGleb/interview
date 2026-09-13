// Run from the deployed account API directory with its environment loaded.
// Prints entitlement metadata only, never credentials or signed keys.
const req = require('node:module').createRequire(process.cwd() + '/package.json');
const { PrismaService } = req('./dist/prisma/prisma.service.js');
const { SubscriptionsService } = req('./dist/subscriptions/subscriptions.service.js');
const db = new PrismaService();
(async()=>{
  const email=process.argv[2].trim().toLowerCase();
  const user=await db.user.findUnique({where:{email}});
  if(!user?.emailVerifiedAt) throw new Error('Verified account not found');
  const service=new SubscriptionsService(db);
  const subscription=await service.getSubscriptionInfo(user.id);
  const license=await service.getManagedLicense(user.id);
  console.log(JSON.stringify({subscription,managedLicenseActive:license.active,managedLicenseExpiresAt:license.expiresAt}));
})().catch(()=>{console.error('Account entitlement check failed');process.exitCode=1}).finally(()=>db.$disconnect());
