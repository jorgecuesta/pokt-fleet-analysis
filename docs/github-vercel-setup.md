# Put the refined fleet analyser on GitHub and Vercel

Prepared 13 October 2026. Follow one stage at a time. You already collected the month; publication requires no repeat collection or notebook run.

The goal is two links: **GitHub for the code** and **Vercel for the usable website**. The current private ChatGPT Site is already published separately. These instructions do not change accounts or send anything to Ramiro.

## What you are working with

| Item | What it does |
|---|---|
| The refined ZIP | Contains the source, verified month, prebuilt website, notebooks and this guide |
| Extracted project folder | Lets you review the downloaded files before placing them in a repository |
| GitHub Desktop repository folder | Your working source folder; commits save versions, pushes upload them |
| Python | Runs collection and the local review server; keep the installation that ran your notebooks |
| Node.js 22 | Runs the JavaScript checks and website build |
| npm | Comes with Node; starts the commands in package.json |
| GitHub | Stores the public source and runs the prepared verification workflow |
| Vercel | Builds that source and serves its saved website |
| Jupyter | Explains collection cell by cell; it is not required for this setup |

Use your actual folder names. These are examples:

| Folder | Example | Purpose |
|---|---|---|
| Collection work | Your existing folder under Documents\1 --- pokt | Keep notebooks and raw caches where they already work |
| Extracted review | Documents\1 --- pokt\fleet-review\pokt-fleet-analysis | Review the downloaded package |
| GitHub working copy | Documents\GitHub\pokt-fleet-analysis | Copy the extracted source here, then commit and publish |

**The project root means the folder containing package.json directly.** If you only see another folder, open that folder first.

## Stage 1 — Extract and open the current product

1. Download **pokt_fleet_analysis_refined_2026-10-13.zip**. Use this refined package for the new wording.
2. Open File Explorer and go to Downloads, or the folder where your browser saved it.
3. Right-click the ZIP and choose **Extract All…**.
4. Choose a new review folder, for example Documents\1 --- pokt\fleet-review. Click **Extract**. Wait until extraction finishes.
5. Open the extracted **pokt-fleet-analysis** folder. You should directly see package.json, START_HERE.md, Open_Local_Review.cmd, src, data, dist and docs.
6. Double-click **Open_Local_Review.cmd**. It finds your existing Python, checks the saved monthly asset and opens a local browser page. Keep its command window open.
7. If it cannot find Python, click File Explorer's address bar, type **cmd**, and press Enter. Run one of the following using your working Python command:

```bat
py -3 scripts\review_locally.py
```

or:

```bat
python scripts\review_locally.py
```

Use the URL printed by the script, normally http://127.0.0.1:8000/. It tries a nearby free port if 8000 is busy. This address serves files from your laptop. It is not a public deployment.

8. Complete the six checks in START_HERE.md and the fuller docs/review-guide.md checklist. Check narrow/mobile layout, keyboard focus, sharing and a real compressed download.
9. Confirm the new **Past performance** tab, explicit **Verified recorded settlements** and **Original sampled payout evidence** labels, and specific reasons on sparse rows.
10. Expected data: **6 September–5 October · 30 days · 8 services**, **851,096 indexed claims / 29,448 settled sessions**. The older sampled payout drawer still shows **1,652 / 4,080 = 40.5%**. That is intentional.
11. When finished, press **Ctrl+C** in the local server window. If the launcher then asks you to press a key, do so.

**Checkpoint:** the current product opens locally and passes your browser review. This requires neither Node nor a new notebook run. Native browser QA has not already been claimed by the automated tests.

## Stage 2 — Find your GitHub repository folder

12. Open **GitHub Desktop**. Sign into your intended GitHub account if necessary.
13. Click **Current Repository** near the top left. If the project repository you created earlier is listed, select it.
14. Choose **Repository → Show in Explorer**. This opens the actual local repository folder. Keep this window open.
15. If you have not created a local repository, choose **File → New repository…**. Set Name to **pokt-fleet-analysis** and Local path to a convenient parent, such as Documents\GitHub. The app creates the project folder beneath that parent.
16. Use the source package's existing README and ignore rules. You can leave the new-repository Git ignore and licence options unchanged. Click **Create repository**, then **Repository → Show in Explorer**.
17. You now have two File Explorer windows: the extracted review folder and the GitHub repository folder. The repository is your working copy; use it for the commands below.

**Checkpoint:** GitHub Desktop has your project selected, and Show in Explorer opens its repository folder. Reuse an existing repository instead of creating another one.

## Stage 3 — Copy the source into that repository

18. In the extracted project-root window, press **Ctrl+A**, then **Ctrl+C**. Select its contents, including src, data, docs and package.json.
19. Switch to the GitHub repository window and press **Ctrl+V**.
20. If Windows asks about replacing old product files, choose **Replace the files in the destination**. Keep the repository's existing Git history.
21. Check that **package.json and vercel.json are directly inside the repository folder**. They must not be buried inside a nested pokt-fleet-analysis folder.
22. Return to GitHub Desktop. Its **Changes** list should show actual source/data files. If you only see a ZIP, you copied the archive instead of its extracted contents.
23. Keep raw collection caches and notebook work folders outside this repository. The packaged data files, reference data, suffix list and tests belong in it. The clean ZIP contains no Git history, Site identity or credentials.

**Checkpoint:** the repository root contains package.json, src, data, collector, analysis, tests, scripts, docs, notebooks and .github. GitHub Desktop shows the copied changes.

## Stage 4 — Check Node and Python

24. In the repository's File Explorer window, click the address bar, type **cmd**, and press Enter. This opens **Command Prompt in the correct folder**.
25. The text before the blinking cursor should end in your repository folder. Run:

```bat
dir package.json
```

It should list that file. If it says File Not Found, return to step 21.

26. Run these individually:

```bat
node --version
npm --version
python --version
```

27. If Node starts with **v22**, keep it. If missing or another version, open https://nodejs.org/en/download. Choose **Node.js 22 LTS**, **Windows**, and **Windows Installer (.msi)**. Use x64 for an Intel/AMD Windows laptop; use ARM64 for an ARM Windows machine.
28. Run the installer. Accept the licence and retain the normal components, including npm and Add to PATH. Extra native build tools are not required here.
29. Close the old Command Prompt. Open a new one in the same repository folder and repeat the version commands; the old window may not see the updated PATH.
30. Keep the Python that successfully ran your notebook. If python is unavailable but **py --version** works, use **py -3** instead of python below. You do not need to reinstall Python 3.13 to publish. The GitHub workflow installs its own configured Python automatically.

**Checkpoint:** node reports v22…, npm reports a version, and either python or py runs your existing Python. Node and Python perform different jobs.

## Stage 5 — Check and build the working copy

Run each command separately in that same repository Command Prompt. Wait for one to finish before starting the next.

31. Run the product tests:

```bat
npm test
```

Expected: **80 tests pass, zero fail**.

32. Run the Python tests:

```bat
python -m unittest discover -s tests -p "test_*.py" -v
```

If your command is py, use **py -3 -m unittest discover -s tests -p "test_*.py" -v**. Expected: **101 tests and OK**. These offline tests do not recollect the month.

33. Build the website:

```bat
npm run build
```

Expected: Built dist/index.html, plus the hashed monthly settlement binary asset. This creates the files Vercel will serve.

34. Check that build:

```bat
npm run check
```

Expected: bundle checks pass, **134 generated/example reports** and **33 recorded mainnet reports** satisfy the schema. The actual monthly integration is additionally checked by npm test.

35. Run **python scripts\review_locally.py** from the repository to inspect the newly built working copy. Use py -3 if appropriate. Confirm the same refined UI and saved month, then stop the server with Ctrl+C.

No npm install is required because this project has no external npm dependencies. Normal builds use saved data and do not query Pocket APIs. If a command fails, copy its complete error and resolve it before treating that build as successful.

**Checkpoint:** product tests, Python tests, build and checks pass in the repository you will upload.

## Stage 6 — Commit and publish on GitHub

36. Return to GitHub Desktop and review the **Changes** list.
37. In the lower-left **Summary** box, type **Add refined monthly fleet analysis**. The longer Description box is optional.
38. Click **Commit to main**, or the displayed default-branch name. A commit saves this source version on your computer.
39. If this repository has never been uploaded, click **Publish repository** near the top.
40. Confirm the account and name **pokt-fleet-analysis**. To publish publicly, **untick Keep this code private**, then click **Publish Repository**. If already published, click **Push origin** instead; that uploads your local commits.
41. Choose **Repository → View on GitHub**. Confirm package.json appears at the top level and the repository is **Public**.
42. If an existing repository is Private and you want it Public, use its GitHub **Settings**, find **Danger Zone → Change repository visibility**, choose Public, and follow the site's confirmation prompts.
43. Open **Actions → Verify fleet analysis**, then click the run for your latest commit.
44. Wait for it to finish successfully. If a job fails, click that job and copy the error from its log. These checks run on GitHub's computer, separately from your laptop and Vercel.
45. Copy the repository URL from your browser's address bar. That is the source-code link you will later share with Ramiro.

**Checkpoint:** a public GitHub repository contains the current source, both saved evidence sets and the collection code, with a successful verification run. There is no need to use GitHub Pages; Vercel hosts the website.

## Stage 7 — Import into Vercel

46. Open https://vercel.com/ and sign into the intended account.
47. On its dashboard, click **Add New… → Project**, or **New Project**.
48. In **Import Git Repository**, connect your GitHub account if needed.
49. When GitHub asks which repositories Vercel can access, select this project repository. Choose the intended personal account or organisation.
50. Find **pokt-fleet-analysis** in the import list and click **Import**. If absent, check the account selector and the GitHub repository-access controls.
51. Set the following values. The included vercel.json already supplies the build/output configuration:

| Field | Value | Meaning |
|---|---|---|
| Project name | pokt-fleet-analysis, or an available name | Names this deployment |
| Framework preset | **Other** | The product is a static JavaScript website |
| Root directory | **./**, the repository root | package.json belongs here; do not choose src or dist |
| Build command | **npm run build** | Creates the deployable files |
| Output directory | **dist** | The HTML and saved monthly asset are here |
| Install command | Default | No external npm dependencies |
| Node.js version | **22.x** | Matches the package pin and prepared workflow |
| Environment variables | **Leave empty** | This saved-data website needs no Pocket API key |
| Production branch | main or your actual default branch | Pushes here normally update the production site |

52. If Node version is not shown during import, open the project's **Settings → Build and Deployment → Node.js Version**. The package also pins **engines.node = 22.x**; package.json can override a dashboard choice.
53. Click **Deploy** once. Watch the build log. It should run npm run build and produce the dist files.
54. Wait for **Ready**, then click **Visit**. Copy the assigned **production .vercel.app URL**. Use the URL Vercel gives this project.
55. Check the new wording, month/date/services, searches, F sorting, Past performance, drawers and a complete result download.
56. Open the production URL in a private/incognito browser window. That checks the experience of someone who is not signed into your Vercel account.
57. If the intended production domain asks visitors to authenticate with Vercel, inspect **Settings → Deployment Protection**. Set its protection scope so the production domain you intend to share is publicly accessible.
58. Keep both links: **GitHub for source** and **Vercel production for the product**. The private ChatGPT Site is a separate deployment.

**Checkpoint:** the Vercel production domain opens for an ordinary visitor and shows the same refined saved month.

## Stage 8 — Hand Ramiro the complete implementation

59. After production review, share the GitHub and Vercel URLs. No message has been sent automatically.
60. Direct him to **notebooks/pokt_settlement_collection.ipynb**, **collector/**, **analysis/** and **docs/data-collection.md**.
61. The notebook explains the complete staged collection and starts offline. The Python modules are the implementation to review for efficiency. Supporting reference/suffix files remain in the repository beside that code.
62. Do not send only the old pokt_live_collector.py; the newer settlement path uses it alongside other modules. A public repository lets him inspect the complete implementation and dependencies without a separate large ZIP.

## Later updates

Change source or verified saved data, run checks, commit, and push. Vercel normally builds updates pushed to its connected production branch. This does not automatically run the Pocket collector or refresh data. The optional monthly collection Action runs only when explicitly started; it produces an artifact and does not commit or deploy it for you.

For a new date window, preserve the new collection's dates/cutoff/hashes and update the frozen verification cases deliberately. Do not bypass an old checksum failure or overwrite the selection sample with settlement-only evidence. The existing completed month needs no further collection to publish.

## Common mistakes and the exact remedy

| Symptom | What to do |
|---|---|
| package.json not found | You are in the wrong or nested folder; return to the project root |
| You see only the ZIP in GitHub Desktop | Copy extracted contents instead of the archive |
| node/npm not recognised | Install Node 22, then close and reopen Command Prompt |
| npm.ps1 execution-policy error | Use Command Prompt opened by typing cmd in File Explorer's address bar |
| Python opens the Store or is unavailable | Try the existing py -3 launcher used by your notebook |
| Local page will not load | Keep the server window open and use its exact printed URL |
| Saved asset missing/checksum failure | Extract the complete package again; serve all dist files together |
| GitHub Actions fails | Open the failed job and copy the full log error |
| Vercel cannot find package.json | Correct its Root Directory and the repository's folder nesting |
| Vercel has no output directory | Use npm run build and Output Directory dist |
| Others face a sign-in wall | Check production-domain Deployment Protection |
| 40.5% still appears in the original sample drawer | Expected; the separate verified earnings cohort has a different denominator |

## Official instructions checked for this guide

- https://docs.github.com/en/desktop/overview/creating-your-first-repository-using-github-desktop
- https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-an-existing-project-to-github-using-github-desktop
- https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- https://nodejs.org/en/download
- https://vercel.com/docs/git
- https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
- https://vercel.com/docs/deployment-protection

Authoring checks here use Node.js 24.19.0 and Python 3.12.14. The prepared GitHub workflow uses Node.js 22 and Python 3.13. Actual GitHub/Vercel account runs and native desktop/mobile browser review remain to be completed.
