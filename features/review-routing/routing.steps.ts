import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";

const feature = await loadFeature("features/review-routing/routing.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("Owner pull request routes Woodhouse as reviewer", () => {});
  Scenario("Bot pull request with its own auto-merge routes Woodhouse as reviewer", () => {});
  Scenario("Bot pull request without auto-merge routes the owner as reviewer", () => {});
  Scenario("Author outside both lists routes the owner as reviewer", () => {});
  Scenario("Draft pull request gets no reviewer", () => {});
  Scenario("Draft becoming ready is routed", () => {});
  Scenario("Late auto-merge toggle re-routes to Woodhouse", () => {});
  Scenario("Re-routing withdraws the previous reviewer", () => {});
});
