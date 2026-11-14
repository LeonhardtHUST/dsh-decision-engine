export default {
  extends: ["@commitlint/config-angular"],
  plugins: [{
    rules: {
      "subject-has-han": ({ subject }) => [
        typeof subject === "string" && /\p{Script=Han}/u.test(subject),
        "提交说明必须包含汉字，请使用简体中文描述更改",
      ],
    },
  }],
  rules: {
    "subject-has-han": [2, "always"],
    "subject-case": [0],
  },
};
