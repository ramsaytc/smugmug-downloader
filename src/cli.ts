#!/usr/bin/env node
import { Command } from "commander";
import { login } from "./oauth.js";
import { requireCredentials } from "./config.js";
import { SmugMugClient } from "./smugmugApi.js";
import { galleryLabel, listGalleries } from "./gallery.js";
import { runDownload } from "./download.js";
import { runSizeEstimate } from "./size.js";

const program = new Command();

program
  .name("smugmug-dl")
  .description("Download every gallery from a SmugMug account")
  .version("1.0.0");

program
  .command("login")
  .description("Authorize this tool against your SmugMug account (OAuth 1.0a)")
  .requiredOption("--api-key <key>", "SmugMug API key (get one at https://api.smugmug.com/api/developer/apply)")
  .requiredOption("--api-secret <secret>", "SmugMug API secret")
  .action(async (opts: { apiKey: string; apiSecret: string }) => {
    await login(opts.apiKey, opts.apiSecret);
  });

program
  .command("whoami")
  .description("Show the authenticated SmugMug account")
  .action(async () => {
    const client = new SmugMugClient(requireCredentials());
    const res = await client.get<any>("/api/v2!authuser");
    const user = res.Response.User;
    console.log(`Logged in as ${user.Name} (@${user.NickName})`);
  });

program
  .command("list")
  .description("List every gallery (folder path + album name)")
  .option("--json", "output as JSON instead of plain text")
  .action(async (opts: { json?: boolean }) => {
    const client = new SmugMugClient(requireCredentials());
    const galleries = await listGalleries(client);
    if (opts.json) {
      console.log(JSON.stringify(galleries, null, 2));
    } else {
      for (const g of galleries) console.log(galleryLabel(g));
      console.log(`\n${galleries.length} galleries total.`);
    }
  });

program
  .command("size")
  .description("Estimate total size of all (or selected) galleries without downloading")
  .option("--gallery <name...>", "only these galleries: bare name or full path from `list` (repeatable)")
  .option("--include <pattern>", "only include galleries whose path matches this regex")
  .option("--exclude <pattern>", "exclude galleries whose path matches this regex")
  .option("--by-gallery", "show a per-gallery breakdown, not just the total", false)
  .action(async (opts: { gallery?: string[]; include?: string; exclude?: string; byGallery: boolean }) => {
    const client = new SmugMugClient(requireCredentials());
    await runSizeEstimate(client, {
      include: opts.include ? new RegExp(opts.include, "i") : undefined,
      exclude: opts.exclude ? new RegExp(opts.exclude, "i") : undefined,
      onlyGalleries: opts.gallery,
      byGallery: opts.byGallery,
    });
  });

program
  .command("download")
  .description("Download all (or selected) galleries to disk")
  .option("-o, --out <dir>", "output directory", "./smugmug-download")
  .option("-c, --concurrency <n>", "parallel image downloads", "6")
  .option("--album-concurrency <n>", "galleries processed in parallel", "3")
  .option("--gallery <name...>", "only these galleries: bare name or full path from `list` (repeatable)")
  .option("--include <pattern>", "only include galleries whose path matches this regex")
  .option("--exclude <pattern>", "exclude galleries whose path matches this regex")
  .option("--force", "re-download files even if they already exist", false)
  .option("--dry-run", "show what would be downloaded without downloading", false)
  .option("--no-metadata", "skip writing a _metadata.json file per gallery")
  .action(
    async (opts: {
      out: string;
      concurrency: string;
      albumConcurrency: string;
      gallery?: string[];
      include?: string;
      exclude?: string;
      force: boolean;
      dryRun: boolean;
      metadata: boolean;
    }) => {
      const client = new SmugMugClient(requireCredentials());
      await runDownload(client, {
        outDir: opts.out,
        concurrency: Number(opts.concurrency),
        albumConcurrency: Number(opts.albumConcurrency),
        force: opts.force,
        dryRun: opts.dryRun,
        metadata: opts.metadata !== false,
        include: opts.include ? new RegExp(opts.include, "i") : undefined,
        exclude: opts.exclude ? new RegExp(opts.exclude, "i") : undefined,
        onlyGalleries: opts.gallery,
      });
    }
  );

await program.parseAsync(process.argv);
