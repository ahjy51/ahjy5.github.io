export interface Post {
  slug: string;
  title: string;
  description: string;
  date: string;
  tags: string[];
  hidden: boolean;
}

export const posts: Post[] = [
  {
    slug: "test",
    title: "test",
    description: "test",
    date: "2026-07-01",
    tags: [],
    hidden: false,
  },
  {
    slug: "newtest",
    title: "测试",
    description: "测试",
    date: "2026-06-30",
    tags: ["技术"],
    hidden: false,
  },
  {
    slug: "hello-world",
    title: "Hello World — 古典部始動",
    description: "これは、古典部のブログです。日々の気づきや学びを綴っていきます。",
    date: "2026-06-28",
    tags: ["日常","第一篇文章"],
    hidden: false,
  },
  {
    slug: "new-post-guide",
    title: "新建文章并推送指南",
    description: "从创建文章到推送到 GitHub Pages 的完整操作流程",
    date: "2026-06-28",
    tags: ["指南","博客"],
    hidden: false,
  },
];

export function getSortedPosts(): Post[] {
  return posts.filter((post) => !post.hidden).sort((a, b) => b.date.localeCompare(a.date));
}
