- The documentation, the App manifest and the examples describe a general
  GitHub connector for any MCPL host: the name of the first target
  repository, internal task identifiers and work-package references are gone
  from the README, `docs/` and the source file headers. The App manifest's
  proposed name is `my-github-agent`, the examples use `my-agent[bot]`, and
  the links to the sibling packages point at their GitHub repositories. Test
  data uses neutral repository and bot names; the two documentation tests
  are `test/docs.test.ts` and `test/policies.test.ts`.
