/**
 * Every item of the setup journey, in the order a person goes through it, with the words that
 * explain it. The dashboard, the plain terminal output and the support report all read from here,
 * so what a step is called and how it is explained is decided in one place.
 *
 * Written for someone who has never heard of a vault or an API key: `short` says what is
 * happening in one line, `long` says why it matters, and `fix` is what to try when it fails.
 */
export type JourneyItem = {
  id: string;
  title: string;
  short: string;
  long: string;
  fix: string;
};

export const JOURNEY: readonly JourneyItem[] = [
  {
    id: "installed",
    title: "Install the services",
    short: "Docker downloaded the four services and started them on this machine.",
    long: "The installer checked Docker, downloaded the service images and started them: a database, the wallet service that holds the keys, the wallet manager your backend talks to, and this setup.",
    fix: "Run the installer again. If Docker reports an error, start Docker first.",
  },
  {
    id: "platform",
    title: "Choose the platform",
    short: "The platform is the prediction market your users will trade on.",
    long: "Your install connects to one platform and fetches its settings from it: which blockchain, which contracts, and the addresses of its services. Production is the real market; the others are for testing.",
    fix: "Check the address with the platform team, and that this machine can reach the internet.",
  },
  {
    id: "key",
    title: "Check your builder key",
    short: "Your builder private key proves to the platform that this install is yours.",
    long: "The platform team gave you a key starting with bld_sk_. Setup checks the platform accepts it before anything is created. It is stored only on this machine, and in your backup kit.",
    fix: "Copy the whole key again from the backoffice, and check it was issued for the platform you chose.",
  },
  {
    id: "mode",
    title: "Choose how funds are held",
    short: "Decide whether each user holds their own funds, or your company pays for their trades.",
    long: 'In "segregated" mode each user\'s wallet holds and spends its own funds. In "shared" mode one operations wallet of yours pays for every user\'s trades. This is written into the database and can never be changed.',
    fix: "If you are not sure, choose segregated, and ask the platform team before confirming.",
  },
  {
    id: "write-config",
    title: "Save the configuration",
    short: "Writes the settings both services start with, including freshly generated secrets.",
    long: "Setup generates the encryption keys and API keys this install uses, then writes each service's settings file. Until this exists the services wait.",
    fix: "This only fails if the disk is full or not writable. Check the free space.",
  },
  {
    id: "wallet-ready",
    title: "Start the wallet service",
    short: "Waits for the wallet service to read its settings and prepare its database.",
    long: "The wallet service creates and signs with your users' keys. On its first start it prepares its database tables, which can take a minute.",
    fix: 'See why it does not start: run "./dpm-custody logs dpm-wallet".',
  },
  {
    id: "vault-init",
    title: "Create the secure key vault",
    short: "Creates the vault that protects every key this install will hold.",
    long: "The vault is where the wallet service keeps the keys that sign for your users. It is created once, with the key provider, and is what makes the keys recoverable from the backup kit.",
    fix: "Usually the key provider is briefly unreachable. Wait a minute.",
  },
  {
    id: "manager-ready",
    title: "Start the wallet manager",
    short: "Waits for the wallet manager, the service your backend talks to.",
    long: "The wallet manager decides who may do what with which wallet, and keeps the audit log. On its first start it prepares its database and records the custody mode for good.",
    fix: 'See why it does not start: run "./dpm-custody logs dpm-wallet-manager".',
  },
  {
    id: "master-wallet",
    title: "Create the master wallet",
    short: "Creates your company's master wallet, which owns the install's funds.",
    long: "The master wallet is the only one allowed to send funds out of the install. It is registered with the platform, so this step talks to the platform's services too.",
    fix: "The platform may be busy. Wait a few minutes. If it keeps failing, contact support.",
  },
  {
    id: "operations-wallet",
    title: "Create the operations wallet",
    short: "Creates the wallet that pays for your users' trades (shared mode only).",
    long: "In shared mode one operations wallet buys on behalf of every user, so users never need funds of their own. It is created and registered with the platform like the master wallet.",
    fix: "The platform may be busy. Wait a few minutes. If it keeps failing, contact support.",
  },
  {
    id: "operator-key",
    title: "Issue the key for your backend",
    short: "Creates the API key your own backend will use to talk to the wallet manager.",
    long: "Your backend calls the wallet manager to create wallets and sign orders. This key lets it do that, and nothing more: it cannot send funds out of the install.",
    fix: "Usually temporary. If it fails again, contact support.",
  },
  {
    id: "verify",
    title: "Check everything works",
    short: "Asks the wallet manager whether every part is in place and connected.",
    long: "A final check: the mode is right, the wallet service is reachable, the vault is ready, and the wallets exist. If anything is missing, setup says which part.",
    fix: "If the same part is missing again, contact support.",
  },
  {
    id: "owner",
    title: "Create your admin login",
    short: "Choose the username and password for the admin dashboard.",
    long: "The admin dashboard shows your wallets, API keys and audit log, and lets you add colleagues. This first login is its owner. The password is sent straight to the wallet manager and not kept by setup.",
    fix: "Use 3-64 letters, digits, '.', '_', '-' or '@' for the username, and at least 12 characters for the password.",
  },
  {
    id: "backup",
    title: "Save the backup kit",
    short: "The backup kit is the only way to recover this install on another machine.",
    long: "It holds the encryption keys and API keys of this install. Store it somewhere safe and private, such as a password manager. Anyone who has it can control the install, so never send it to anyone, support included.",
    fix: 'Print it again at any time with "./dpm-custody backup-kit".',
  },
];

export function journeyItem(id: string): JourneyItem {
  const item = JOURNEY.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No journey item "${id}"`);
  return item;
}
