- The documentation, the App manifest and the examples describe a general
  GitHub connector for any MCPL host: the name of the first target
  repository, internal task identifiers and work-package references are gone
  from the README, `docs/` and the source and test file headers, apart from
  the branch and marker names the end-to-end report's transcript records.
  The App's proposed name is `my-github-agent` in the manifest and in the
  README's examples, and the links to the sibling packages point at their
  GitHub repositories. Test data uses neutral repository and bot names; the
  two documentation tests are `test/docs.test.ts` and
  `test/policies.test.ts`.
