# testbed

A public shelf for single-file web apps. Each one is developed in its own
repository (most of them private) and deployed here into its own directory,
so there is one URL, one Pages site, and one place to find them.

**→ https://pkronstrom.github.io/testbed/**

## What lives here

```
/                     the landing page — a grid of whatever is deployed
/apps.json            generated on every push by scanning the directories
/<app>/               one deployed app, pushed by that app's own repository
/<app>/app.json       its name, description and tags, written by that repo
```

Nothing in an app directory is edited by hand. The source of truth for
`/packcraft/` is the packcraft repository; its deploy workflow force-replaces
that directory on every push to its default branch.

## Why the source repos stay private

These apps are single-file HTML — deploying one publishes its code, so this
arrangement is not about hiding the app. What stays private is the workshop:
commit history, design notes, reference photographs, measurements, test
suites, and the long tail of things that were tried and abandoned.

## Adding an app

In the app's repository, add a workflow that:

1. runs whatever gates the project has (tests, linters) — a broken app should
   not reach the shelf;
2. assembles the runtime files into `dist/`;
3. writes `dist/app.json`:

   ```json
   {
     "name": "Packraft Designer",
     "description": "Design a packraft and export its 1:1 cutting pattern.",
     "tags": ["geometry", "offline"]
   }
   ```

4. pushes `dist/` into `<app>/` here, using a deploy key or a fine-grained
   token stored as a secret in that repository. See
   `.github/workflows/pages.yml` in the packcraft repository for a worked
   example.

The push triggers this repository's own workflow, which regenerates
`apps.json` and redeploys the site. The landing page needs no editing.

## Ground rules

- **No build step.** Everything served here is a file a browser can open
  directly, which is also how the apps are developed and debugged.
- **No third-party runtime dependencies.** Libraries are vendored into the
  app's own directory, so a page cannot break because a CDN moved.
- **Offline-capable.** Every app should still work from `file://`.
