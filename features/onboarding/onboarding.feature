@REC-19
Feature: Onboarding
  As the owner of a repository Woodhouse is installed on
  I want an onboarding pull request that adds the configuration file
  So that merging it is the whole opt-in to settings management

  @REC-19
  Scenario: Fresh install
    When the App is installed on a repository with no settings file
    Then Woodhouse opens an onboarding pull request adding the starter configuration

  @REC-19
  Scenario: Repository added to an existing installation
    When a repository is added to an installation that already existed
    Then the same onboarding offer is made for that repository

  @REC-19
  Scenario: Fresh install on all repositories
    When the App is newly installed with repository selection All and the delivery carries no repository list
    Then Woodhouse enumerates the repositories accessible to the installation and makes the same onboarding offer to each of them

  @REC-19
  Scenario: An existing installation is switched to all repositories
    When an existing installation's repository selection is switched to All and the delivery enumerates the newly-accessible repositories
    Then the newly-accessible repositories are treated like any other batch — repositories without a config file receive the offer and those with one are skipped

  @REC-19
  Scenario: Enumeration fails
    When enumerating the repositories accessible to the installation fails
    Then no onboarding pull requests are opened for that delivery and the failure is logged

  @REC-19
  Scenario: Local config already present
    When the App is installed on a repository that already has ".github/woodhouse.yaml"
    Then no onboarding pull request is opened

  @REC-19
  Scenario: The baseline repository is offered like any other
    When the App is installed on the baseline repository, which carries a root "woodhouse.yml" but no ".github/woodhouse.yml"
    Then the onboarding offer is made for it — the root baseline file is not a local settings file

  @REC-19
  Scenario: A repository under an enabled baseline still receives the offer
    When a repository has no settings file and the owner baseline resolves settings management on
    Then the onboarding offer is still made for it — the local file is the per-repository opt-in

  @REC-19
  Scenario: The open-pull-request probe fails
    When a repository has no settings file and the probe for an open onboarding pull request fails
    Then no onboarding pull request is opened for it, the failure is logged, and the walk continues with the remaining repositories

  @REC-19
  Scenario: Re-delivery
    Given an onboarding pull request is open for a repository
    When the installation event re-delivers while the onboarding pull request is open
    Then no second branch, commit, or pull request is created

  @REC-19
  Scenario: Closed without merging
    Given the onboarding pull request was closed without merging
    When no installation event follows
    Then the repository remains un-onboarded and untouched

  @REC-19
  Scenario: Repeated enumeration
    Given an acted-on installation event that carries no repository list
    When it re-delivers, so the accessible-repository enumeration runs again
    Then no second branch, commit, or pull request is created for any repository in the enumerated batch

  @REC-19
  Scenario: The onboarding pull request merges
    When the onboarding pull request merges into the default branch
    Then the settings sync runs for the repository and the outcome comment is left on the pull request

  @REC-19
  Scenario: Pull request on an un-onboarded repository
    When any pull request opens in a repository with no settings file
    Then the white-glove check is posted and no settings are written

  @REC-19
  Scenario: Dry-run installation
    When the App is installed on a repository while dry-run mode is on
    Then the would-be onboarding pull request is logged and no branch, commit, or pull request is created
