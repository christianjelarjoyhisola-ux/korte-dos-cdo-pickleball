import { getState, resetDemo, subscribe, updateBrand } from "./data.js?v=20260803-9";
import { renderPlayerView } from "./views/player-view.js?v=20260803-9";
import { renderOperationsView } from "./views/operations-view.js?v=20260803-9";
import { renderPlayInsightsView } from "./views/play-insights-view.js?v=20260803-9";

const roles = {
  owner: { label: "Owner", icon: "O", description: "Revenue and control" },
  desk: { label: "Front desk", icon: "F", description: "Schedule and arrivals" },
  host: { label: "Play host", icon: "H", description: "Sessions and rotation" },
  player: { label: "Player", icon: "P", description: "Book and join play" }
};

const ownerNav = [
  ["Operations", "today", "Today", "i-grid"],
  [null, "schedule", "Schedule", "i-calendar"],
  [null, "play", "Play", "i-play"],
  [null, "customers", "Customers", "i-users"],
  ["Business", "money", "Money", "i-wallet", 2],
  [null, "insights", "Insights", "i-chart"],
  [null, "venue", "Venue & settings", "i-settings"]
];

const roleNavigation = {
  owner: ownerNav,
  desk: [["Front desk", "today", "Today", "i-grid"], [null, "schedule", "Schedule", "i-calendar"], [null, "customers", "Customers", "i-users"], [null, "money", "Payments", "i-wallet", 2]],
  host: [["Play operations", "play", "Live session", "i-play"], [null, "schedule", "Court schedule", "i-calendar"], [null, "insights", "Session insights", "i-chart"]],
  player: [["Player", "book", "Book", "i-calendar"], [null, "join", "Open Play", "i-users"], [null, "visit", "My visit", "i-grid"], [null, "live", "Live board", "i-play"]]
};

const titles = {
  today: ["Friday operations", "Today"], schedule: ["Live court plan", "Schedule"], play: ["Beginner Social · Live", "Play"],
  customers: ["Players and guests", "Customers"], money: ["Payments and settlement", "Money"], insights: ["Venue performance", "Insights"],
  venue: ["Configuration", "Venue & settings"], book: ["Horizon Pickle Club", "Book a court"], join: ["Horizon Pickle Club", "Open Play"],
  visit: ["Your reservation", "My visit"], live: ["Player view", "Live match board"]
};

const initialParams = new URLSearchParams(window.location.search);
let role = roles[initialParams.get("role")] ? initialParams.get("role") : "owner";
let view = initialParams.get("view") || (role === "player" ? "book" : role === "host" ? "play" : "today");
let cleanupView = null;
let tourIndex = 0;

const tourSteps = [
  { role: "owner", view: "today", eyebrow: "Owner confidence", title: "Start with the whole day in view", description: "See revenue, occupancy, arrivals and exceptions before the busiest hours begin." },
  { role: "player", view: "book", eyebrow: "Player convenience", title: "Book a court in under one minute", description: "Choose a time, add player details and simulate a familiar Philippine payment without creating an account." },
  { role: "desk", view: "schedule", eyebrow: "Front-desk speed", title: "Watch the reservation appear live", description: "Every court, hold, walk-in and program shares one calm, operational timeline." },
  { role: "owner", view: "money", eyebrow: "Revenue protection", title: "Review payment evidence with confidence", description: "Clear receiver, reference and amount evidence keeps automation explainable and owners in control." },
  { role: "host", view: "play", eyebrow: "Open Play excellence", title: "Balance the next game, not a spreadsheet", description: "Check players in, run courts and publish the live queue from one focused board." },
  { role: "owner", view: "insights", eyebrow: "Growth visibility", title: "Turn empty hours into the next program", description: "Finish with utilization patterns and a transparent ROI scenario using assumptions the owner can edit." }
];

const elements = {
  shell: document.querySelector("#appShell"), sidebar: document.querySelector("#sidebar"), nav: document.querySelector("#mainNav"),
  root: document.querySelector("#viewRoot"), title: document.querySelector("#pageTitle"), eyebrow: document.querySelector("#pageEyebrow"),
  roleTrigger: document.querySelector("#roleTrigger"), roleMenu: document.querySelector("#roleMenu"), roleIcon: document.querySelector("#roleIcon"), roleLabel: document.querySelector("#roleLabel"),
  backdrop: document.querySelector("#mobileBackdrop"), menuButton: document.querySelector("#menuButton"), toastRegion: document.querySelector("#toastRegion")
};

function icon(id) { return `<svg aria-hidden="true"><use href="#${id}"/></svg>`; }

function buildRoleMenu() {
  elements.roleMenu.innerHTML = Object.entries(roles).map(([id, item]) => `
    <button class="role-option ${id === role ? "active" : ""}" role="option" aria-selected="${id === role}" data-role="${id}">
      <span class="role-icon">${item.icon}</span><span><strong>${item.label}</strong><span>${item.description}</span></span>
    </button>`).join("");
}

function buildNavigation() {
  const nav = roleNavigation[role];
  elements.nav.innerHTML = nav.map(([section, id, label, iconId, badge]) => `${section ? `<div class="nav-label">${section}</div>` : ""}<button class="nav-link ${id === view ? "active" : ""}" data-view="${id}">${icon(iconId)}<span>${label}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</button>`).join("");
}

function render() {
  cleanupView?.();
  cleanupView = null;
  elements.roleIcon.textContent = roles[role].icon;
  elements.roleLabel.textContent = roles[role].label;
  const [eyebrow, title] = titles[view] || ["Interactive demo", "RallyOS"];
  elements.eyebrow.textContent = eyebrow;
  elements.title.textContent = title;
  elements.shell.classList.toggle("player-mode", role === "player");
  document.body.classList.toggle("player-mode-active", role === "player");
  buildNavigation();
  buildRoleMenu();
  document.documentElement.style.setProperty("--violet", getState().venue.primary);

  const context = { role, view, navigate, switchRole, notify, icon };
  if (role === "player") cleanupView = renderPlayerView(elements.root, context);
  else if (["play", "insights"].includes(view)) cleanupView = renderPlayInsightsView(elements.root, context);
  else cleanupView = renderOperationsView(elements.root, context);
}

function navigate(nextView) {
  view = nextView;
  syncUrl();
  closeMobileNav();
  render();
  elements.root.focus({ preventScroll: true });
}

function switchRole(nextRole) {
  role = nextRole;
  view = role === "player" ? "book" : role === "host" ? "play" : "today";
  elements.roleIcon.textContent = roles[role].icon;
  elements.roleLabel.textContent = roles[role].label;
  elements.roleMenu.classList.remove("open");
  elements.roleTrigger.setAttribute("aria-expanded", "false");
  syncUrl();
  notify(`Now viewing as ${roles[role].label}`, roles[role].description);
  render();
}

function syncUrl() {
  const next = new URL(window.location.href);
  next.searchParams.set("role", role);
  next.searchParams.set("view", view);
  next.hash = "";
  history.replaceState(null, "", next);
}

function notify(title, message = "Demo data updated instantly across every view.") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `${icon("i-check")}<div><strong>${title}</strong><p>${message}</p></div><button aria-label="Dismiss">×</button>`;
  toast.querySelector("button").addEventListener("click", () => toast.remove());
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

function closeMobileNav() {
  elements.sidebar.classList.remove("open");
  elements.backdrop.classList.remove("open");
  elements.menuButton.setAttribute("aria-expanded", "false");
}

elements.nav.addEventListener("click", event => {
  const button = event.target.closest("[data-view]");
  if (button) navigate(button.dataset.view);
});
elements.roleTrigger.addEventListener("click", () => {
  const open = elements.roleMenu.classList.toggle("open");
  elements.roleTrigger.setAttribute("aria-expanded", String(open));
});
elements.roleMenu.addEventListener("click", event => {
  const option = event.target.closest("[data-role]");
  if (option) switchRole(option.dataset.role);
});
elements.menuButton.addEventListener("click", () => {
  const open = elements.sidebar.classList.toggle("open");
  elements.backdrop.classList.toggle("open", open);
  elements.menuButton.setAttribute("aria-expanded", String(open));
});
elements.backdrop.addEventListener("click", closeMobileNav);
document.addEventListener("click", event => {
  if (!event.target.closest(".role-switcher")) {
    elements.roleMenu.classList.remove("open");
    elements.roleTrigger.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("click", event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "reset") {
    resetDemo();
    notify("Demo reset", "All sample bookings, payments and courts are back to their starting state.");
  }
  if (action === "tour") {
    startTour();
  }
  if (action === "brand-preview") openBrandDialog();
});

const brandDialog = document.querySelector("#brandDialog");
const brandNameInput = document.querySelector("#brandNameInput");
const brandPreviewName = document.querySelector("#brandPreviewName");
const brandPreviewMark = document.querySelector("#brandPreviewMark");
const colors = ["#6558e8", "#146c5b", "#e05b3f", "#2869c8", "#8f4cb8"];
let selectedColor = colors[0];

const tourDialog = document.querySelector("#tourDialog");
const tourStepLabel = document.querySelector("#tourStepLabel");
const tourEyebrow = document.querySelector("#tourEyebrow");
const tourTitle = document.querySelector("#tourTitle");
const tourDescription = document.querySelector("#tourDescription");
const tourProgress = document.querySelector("#tourProgress");
const tourBackButton = document.querySelector("#tourBackButton");
const tourNextButton = document.querySelector("#tourNextButton");

function startTour() {
  tourIndex = 0;
  showTourStep();
  tourDialog.showModal();
}

function showTourStep() {
  const step = tourSteps[tourIndex];
  tourStepLabel.textContent = `Step ${tourIndex + 1} of ${tourSteps.length}`;
  tourEyebrow.textContent = step.eyebrow;
  tourTitle.textContent = step.title;
  tourDescription.textContent = step.description;
  tourProgress.innerHTML = tourSteps.map((_, index) => `<span class="${index <= tourIndex ? "active" : ""}"></span>`).join("");
  tourBackButton.disabled = tourIndex === 0;
  tourBackButton.style.visibility = tourIndex === 0 ? "hidden" : "visible";
  tourNextButton.innerHTML = `${tourIndex === tourSteps.length - 1 ? "Finish on insights" : "Show this step"} ${icon("i-arrow")}`;
}

document.querySelector("#closeTourButton").addEventListener("click", () => tourDialog.close());
tourBackButton.addEventListener("click", () => { tourIndex = Math.max(0, tourIndex - 1); showTourStep(); });
tourNextButton.addEventListener("click", () => {
  const step = tourSteps[tourIndex];
  role = step.role;
  view = step.view;
  elements.roleIcon.textContent = roles[role].icon;
  elements.roleLabel.textContent = roles[role].label;
  syncUrl();
  render();
  if (tourIndex === tourSteps.length - 1) {
    tourDialog.close();
    notify("Tour complete", "You have seen the full player-to-owner operating story.");
    return;
  }
  tourIndex += 1;
  showTourStep();
});

function openBrandDialog() {
  const venue = getState().venue;
  brandNameInput.value = venue.name;
  brandPreviewName.textContent = venue.name;
  brandPreviewMark.textContent = venue.initials;
  selectedColor = venue.primary;
  document.querySelector("#colorOptions").innerHTML = colors.map(color => `<button type="button" class="color-swatch ${color === selectedColor ? "active" : ""}" style="background:${color}" data-color="${color}" aria-label="Select ${color}"></button>`).join("");
  brandDialog.showModal();
}

brandNameInput.addEventListener("input", () => {
  brandPreviewName.textContent = brandNameInput.value || "Your venue";
  brandPreviewMark.textContent = (brandNameInput.value || "YV").split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase();
});
document.querySelector("#colorOptions").addEventListener("click", event => {
  const swatch = event.target.closest("[data-color]");
  if (!swatch) return;
  selectedColor = swatch.dataset.color;
  document.querySelectorAll(".color-swatch").forEach(item => item.classList.toggle("active", item === swatch));
  brandPreviewMark.style.background = selectedColor;
});
document.querySelector("#applyBrandButton").addEventListener("click", event => {
  event.preventDefault();
  updateBrand({ name: brandNameInput.value.trim(), primary: selectedColor });
  brandDialog.close();
  notify("Brand preview applied", "Your venue identity now appears throughout the demo.");
});

subscribe((_state, reason) => {
  if (["reset", "brand-updated"].includes(reason)) render();
});

window.RallyDemo = { navigate, switchRole, notify, resetDemo };
render();
