// The pull requests of the active space's GitHub repo, with filters. A click
// shows a PR; "Check out" makes a Herdr worktree space on its branch, and
// "Check out + review" also starts Claude there with /herdr-review.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, TextView } from "gpui-base";
import { checking, exec, focused, notify, openOverlay, panes, run, spaces, theme } from "herdr";

const LIST_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,isCrossRepository,additions,deletions,statusCheckRollup,url,labels";
const VIEW_FIELDS = `${LIST_FIELDS},body,state,changedFiles,mergeable,reviews,createdAt`;
const STATES = [["open", "Open"], ["merged", "Merged"], ["closed", "Closed"]];
const WHO = [["all", "All", ""], ["mine", "Mine", "author:@me"], ["review", "To review", "review-requested:@me"], ["involves", "Involves me", "involves:@me"]];
const REFRESH_MS = 60000;
const SPINNER = "mods/prs/spinner.svg";

// Where the active space is now, as the Files panel finds it.
function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on, space: space?.id ?? null };
}

// CI state from statusCheckRollup: "fail", "pending", "ok", or null (no checks).
function checks(rollup) {
  if (!rollup?.length) return null;
  const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (rollup.some((c) => bad.includes(c.conclusion) || bad.includes(c.state))) return "fail";
  if (rollup.some((c) => (c.__typename === "CheckRun" && c.status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(c.state))) return "pending";
  return "ok";
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export default class Prs extends View {
  init(_props, cx) {
    this.state = "open";
    this.who = "all";
    this.search = InputState.new({ placeholder: "Search (GitHub syntax), Enter" });
    this.search.on("submit", (_e, cx) => { this.refresh(cx, true); cx.notify(); });
    this.repo = null; // { top, on, name }
    this.where = null;
    this.prs = [];
    this.loading = false;
    this.manual = false; // the person asked for this load (refresh button, filter, search): show the loader
    this.again = false; // a request came during a load: load once more after it
    this.error = null;
    this.detail = null; // { number, pr | null, error }
    this.busy = null;
    if (checking()) return;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // The repo of the active space, found again when the space or folder changes.
  async findRepo() {
    const loc = location();
    const where = JSON.stringify([loc.cwd, loc.on]);
    if (where === this.where && this.repo) return this.repo;
    this.where = where;
    this.repo = null;
    this.prs = [];
    this.detail = null;
    if (!loc.cwd) throw new Error("No folder in this space.");
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.on });
    if (top.code !== 0) throw new Error("This space is not in a git repository.");
    const name = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: top.stdout.trim(), on: loc.on });
    if (name.code !== 0) throw new Error(name.stderr.trim() || "gh cannot find the GitHub repo.");
    this.repo = { top: top.stdout.trim(), on: loc.on, name: name.stdout.trim() };
    return this.repo;
  }

  // manual: the person asked for it, so the list shows the loader (the 60 s timer loads quietly).
  refresh(cx, manual = false) {
    if (manual) this.manual = true;
    if (this.loading) {
      // A filter changed during a load: the result of that load is for the old filter
      this.again = true;
      return;
    }
    // No cx.notify() here: render() calls this when the space changes. Click handlers call it.
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const repo = await this.findRepo();
        const search = [WHO.find(([k]) => k === this.who)[2], this.search.value().trim()].filter(Boolean).join(" ");
        const args = ["pr", "list", "--state", this.state, "--limit", "60", "--json", LIST_FIELDS];
        if (search) args.push("--search", search);
        const r = await exec("gh", args, { cwd: repo.top, on: repo.on, timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "gh pr list failed");
        this.prs = JSON.parse(r.stdout);
        this.error = null;
      } catch (err) {
        this.error = String(err.message ?? err);
      }
      this.loading = false;
      if (this.again) {
        this.again = false;
        this.refresh(cx);
      } else this.manual = false;
      cx.notify();
    });
  }

  // The refresh button: the spinner turns while a load runs.
  refreshButton(t) {
    const el = div().id("prs-refresh").flex_none().size(18).flex().items_center().justify_center();
    if (this.loading) return el.child(svg(SPINNER).size(12).text_color(t.muted).spin(900));
    return el.cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.refresh(cx, true); cx.notify(); }).child("↻");
  }

  open(number, cx) {
    this.detail = { number, pr: this.prs.find((p) => p.number === number) ?? null, full: false, error: null };
    cx.spawn(async (cx) => {
      const repo = this.repo;
      const r = await exec("gh", ["pr", "view", String(number), "--json", VIEW_FIELDS], { cwd: repo.top, on: repo.on, timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.detail?.number !== number) return;
      if (r.code === 0) this.detail = { number, pr: JSON.parse(r.stdout), full: true, error: null };
      else this.detail.error = r.stderr.trim() || "gh pr view failed";
      cx.notify();
    });
  }

  // A Herdr worktree space on the PR's branch. Same-repo PRs track
  // origin/<branch>; fork PRs get a local pr/<n> branch from pull/<n>/head.
  async checkout(pr, review, cx) {
    const { top, on } = this.repo;
    const git = (args, timeout) => exec("git", args, { cwd: top, on, timeout });
    const branch = pr.isCrossRepository ? `pr/${pr.number}` : pr.headRefName;
    const argv = review ? ["claude", "/herdr-review"] : undefined;
    this.busy = `Getting ${branch}…`;
    cx.notify();
    try {
      // A checkout of this branch exists: show it (and start the review there)
      const list = await git(["worktree", "list", "--porcelain"]);
      const blocks = list.stdout.split("\n\n");
      const found = blocks.find((b) => b.split("\n").includes(`branch refs/heads/${branch}`));
      if (found) {
        const path = found.split("\n")[0].replace(/^worktree /, "");
        const space = spaces().find((s) => panes().some((p) => s.tabs.some((t) => t.id === p.tab) && p.cwd && (p.cwd === path || p.cwd.startsWith(`${path}/`))));
        if (space) {
          run("space.select", { id: space.id });
          if (argv) run("tab.new", { space: space.id, folder: path, argv });
        } else run("space.new", { folder: path, machine: on ?? "", argv });
        notify({ title: `#${pr.number} is already checked out`, body: path, level: "info" });
        return;
      }
      const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      if (pr.isCrossRepository) {
        // Never forced: a local pr/<n> with other commits stays as it is
        const f = await git(["fetch", "origin", `pull/${pr.number}/head:${branch}`], 120000);
        if (f.code !== 0 && !exists) throw new Error(f.stderr.trim() || "git fetch failed");
        if (f.code !== 0) notify({ title: `Uses your local ${branch}`, body: "It is not the same as the PR head: git fetch refused to change it.", level: "warning" });
      } else {
        const f = await git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120000);
        if (f.code !== 0) throw new Error(f.stderr.trim() || "git fetch failed");
        if (!exists) {
          const b = await git(["branch", "--track", branch, `origin/${branch}`]);
          if (b.code !== 0) throw new Error(b.stderr.trim() || "git branch failed");
        }
      }
      // The shipped worktree dialog makes the checkout and the space
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { folder: top, machine: on, branch, argv } });
    } catch (err) {
      notify({ title: `Could not check out #${pr.number}`, body: String(err.message ?? err), level: "error" });
    } finally {
      this.busy = null;
      cx.notify();
    }
  }

  // ---- render ---------------------------------------------------------------

  chip(text, color) {
    const t = this.t;
    return div().flex_none().px(5).rounded(4).text_size(10).bg(`${color}26`).text_color(color).child(text);
  }

  pill(id, label, on, onClick) {
    const t = this.t;
    return div().id(id).flex_none().px(8).py(3).rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click(onClick).child(label);
  }

  button(id, label, onClick, primary = false) {
    const t = this.t;
    return h_flex().id(id).flex_none().h(28).px(10).items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .when(Boolean(this.busy), (e) => e.opacity(0.5))
      .on_click((e, cx) => { if (!this.busy) onClick(e, cx); cx.notify(); })
      .child(label);
  }

  badges(pr) {
    const t = this.t;
    const out = [];
    if (pr.isDraft) out.push(this.chip("draft", t.dim));
    if (pr.reviewDecision === "APPROVED") out.push(this.chip("approved", t.ansi2));
    if (pr.reviewDecision === "CHANGES_REQUESTED") out.push(this.chip("changes", t.ansi1));
    const ci = checks(pr.statusCheckRollup);
    if (ci) out.push(div().flex_none().size(7).rounded_full().bg(ci === "ok" ? t.ansi2 : ci === "fail" ? t.ansi1 : t.ansi3));
    return out;
  }

  row(pr) {
    const t = this.t;
    return v_flex().id(`pr-${pr.number}`).px(10).py(7).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.open(pr.number, cx); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .children(this.badges(pr)))
      .child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${pr.author?.login ?? "?"} · ${pr.headRefName} · +${pr.additions} −${pr.deletions} · ${ago(pr.updatedAt)}`));
  }

  list(t) {
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(4).children(STATES.map(([k, label]) => this.pill(`st-${k}`, label, this.state === k, (_e, cx) => { this.state = k; this.refresh(cx, true); cx.notify(); }))))
        .child(h_flex().gap(4).flex_wrap().children(WHO.map(([k, label]) => this.pill(`who-${k}`, label, this.who === k, (_e, cx) => { this.who = k; this.refresh(cx, true); cx.notify(); }))))
        .child(div().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.surface)
          .child(Input.new(this.search).w_full().text_size(12))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .when(this.showLoader(), (e) => e.child(this.loader(t)))
        .when(Boolean(this.error) && !this.showLoader(), (e) => e.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.error)))
        .when(!this.error && !this.prs.length && !this.loading, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child("No pull requests")))
        // The old list stays while it loads, dimmed: the rows do not jump
        .child(v_flex().when(this.showLoader(), (e) => e.opacity(0.4)).children(this.prs.map((pr) => this.row(pr)))));
  }

  // The first load, and each load the person asked for.
  showLoader() {
    return this.loading && (this.manual || !this.prs.length);
  }

  loader(t) {
    return h_flex().flex_none().gap(8).items_center().justify_center().py(10).text_size(12).text_color(t.muted)
      .child(svg(SPINNER).size(14).text_color(t.accent).spin(900))
      .child(this.prs.length ? "Refreshing pull requests…" : "Loading pull requests…");
  }

  details(t) {
    const d = this.detail;
    const pr = d.pr;
    const body = v_flex().id("pr-detail").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(8);
    if (!pr) return body.child(div().text_color(d.error ? t.ansi1 : t.dim).child(d.error ?? "Loading…"));
    const ci = checks(pr.statusCheckRollup);
    const failed = (pr.statusCheckRollup ?? []).filter((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(c.conclusion ?? c.state));
    const reviews = new Map();
    for (const r of pr.reviews ?? []) if (r.state !== "COMMENTED" || !reviews.has(r.author?.login)) reviews.set(r.author?.login, r.state);
    return body
      .child(div().text_size(15).font_semibold().child(pr.title))
      .child(h_flex().gap(6).flex_wrap().items_center().children(this.badges(pr))
        .child(div().text_size(12).text_color(t.muted).child(`${pr.author?.login ?? "?"} · ${pr.headRefName} → ${pr.baseRefName}`)))
      .child(div().text_size(12).text_color(t.dim).child(`+${pr.additions} −${pr.deletions}${pr.changedFiles ? ` · ${pr.changedFiles} files` : ""} · updated ${ago(pr.updatedAt)} ago${pr.isCrossRepository ? " · from a fork" : ""}`))
      .when(Boolean(ci), (e) => e.child(div().text_size(12).text_color(ci === "fail" ? t.ansi1 : ci === "ok" ? t.ansi2 : t.ansi3)
        .child(ci === "fail" ? `Checks failing: ${failed.map((c) => c.name ?? c.context).slice(0, 4).join(", ")}` : ci === "ok" ? "Checks pass" : "Checks running")))
      .when(reviews.size > 0, (e) => e.child(div().text_size(12).text_color(t.muted).child(`Reviews: ${[...reviews].map(([who, s]) => `${who} (${s.toLowerCase().replace("_", " ")})`).join(", ")}`)))
      .child(h_flex().gap(6).flex_wrap().pt(4)
        .child(this.button("co-review", "Check out + review", (_e, cx) => cx.spawn(async (cx) => this.checkout(pr, true, cx)), true))
        .child(this.button("co", "Check out", (_e, cx) => cx.spawn(async (cx) => this.checkout(pr, false, cx))))
        .child(this.button("gh", "GitHub ↗", () => exec("open", [pr.url]))))
      .when(Boolean(this.busy), (e) => e.child(div().text_size(12).text_color(t.muted).child(this.busy)))
      .when(Boolean(d.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(d.error)))
      .child(div().pt(6).border_t_1().border_color(t.border))
      .child(d.full ? TextView.markdown(`pr-body-${pr.number}`, pr.body || "_No description._").selectable().text_size(12) : div().text_size(12).text_color(t.dim).child("Loading the description…"));
  }

  render(cx) {
    const t = theme();
    this.t = t;
    const where = JSON.stringify([location().cwd, location().on]);
    if (!checking() && where !== this.where && !this.loading) this.refresh(cx);
    const title = this.detail ? `#${this.detail.number}` : this.repo?.name ?? "";
    return v_flex().id("prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.detail), (e) => e.child(div().id("prs-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.detail = null; cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Pull requests"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(title))
        .when(!this.detail, (e) => e.child(this.refreshButton(t))))
      .child(this.detail ? this.details(t) : this.list(t));
  }
}
