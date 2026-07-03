export default {
  rules: {
    // Ensure type is in lowercase
    'type-case': [2, 'always', 'lower-case'],
    // Ensure subject is in lowercase
    'subject-case': [2, 'always', 'lower-case'],
    // Ensure subject doesn't end with period
    'subject-full-stop': [2, 'never', '.'],
    // Ensure header max length is 100
    'header-max-length': [2, 'always', 100],
    // Type must be one of the following
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'test',
        'chore',
        'ci',
        'perf',
        'build',
        'revert'
      ]
    ]
  }
};
