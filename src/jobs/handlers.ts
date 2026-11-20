// What each background job does.
//   send_email     — deliver one notification email
//   health_report  — read a verified repo from GitHub and write its health report
//   escrow_sync    — (Escrow.com mode) copy escrow status onto our deals
//   auto_release   — approve payment for deals whose 7-day window ended without a dispute
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import type { Mailer } from "../services/mailer.js";
import type { GitHubApi } from "../services/github.js";
import { analyze, collect, type LatestVersion, type Summarizer } from "../services/healthReport.js";
import type { DealService } from "../services/deals.js";
import type { Handlers } from "./queue.js";

export interface HandlerDeps {
  prisma: Db;
  crypto: Encryptor;
  mailer: Mailer;
  github: GitHubApi;
  latestVersion: LatestVersion;
  summarize: Summarizer;
  deals: DealService;
}

export function createHandlers(d: HandlerDeps): Handlers {
  return {
    send_email: async (job) => {
      await d.mailer(job.payload);
    },

    health_report: async (job) => {
      const asset = await d.prisma.listingAsset.findUnique({ where: { id: job.payload.assetId }, include: { listing: { include: { seller: true } } } });
      if (!asset || asset.kind !== "repo" || !asset.verifiedAt) return;
      const seller = asset.listing.seller;
      if (!seller.githubTokenEnc) return; // GitHub disconnected: nothing to read with
      const input = await collect(d.github, d.crypto.decryptText(seller.githubTokenEnc), asset.reference);
      if (!input) throw new Error(`Could not read ${asset.reference} from GitHub`);
      const result = await analyze(input, d.latestVersion);
      const summary = await d.summarize(result, input);
      await d.prisma.healthReport.create({
        data: {
          listingId: asset.listingId,
          assetId: asset.id,
          score: result.score,
          summary: summary.text,
          usedAi: summary.usedAi,
          reportJson: { repo: input.repo.fullName, checks: result.checks, metrics: result.metrics } as object,
        },
      });
    },

    escrow_sync: async () => {
      await d.deals.syncEscrow();
    },

    auto_release: async () => {
      await d.deals.autoRelease();
    },
  };
}
