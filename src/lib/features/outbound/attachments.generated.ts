/**
 * GENERATED FILE, DO NOT EDIT.
 *
 * Source: nutribiotic/config/attachments.json in the agency repo. The core sales
 * sheets a drafted email may say it carries, each with when it goes;
 * bridges/nutribiotic/order_watch.py attaches them by rule.
 * Regenerate with `python3 scripts/sync_email_voice.py`.
 */

export type AttachableFile = { name: string; use: string };

export const ATTACHABLE_FILES: AttachableFile[] = [
  {
    "name": "Best Sellers",
    "use": "products and wholesale prices, the default for a first email to a store or clinic"
  },
  {
    "name": "Immune Support Training Flyer",
    "use": "any training offer"
  },
  {
    "name": "NutriBiotic Portfolio",
    "use": "the full line, when they asked for information or a catalog"
  },
  {
    "name": "Terms and Price List",
    "use": "opening an account or ordering: how to buy, wholesale, MAP and retail prices, opening-order promotions, the order form"
  },
  {
    "name": "GSE Data Sheet",
    "use": "Grapefruit Seed Extract research, when they asked about GSE or its science"
  },
  {
    "name": "Spa Partner Guide",
    "use": "spas, salons and skin care buyers, in place of Best Sellers"
  }
];
