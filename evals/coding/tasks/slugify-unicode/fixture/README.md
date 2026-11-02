# slugify

`slugify(input)` 把一个标题转成 URL slug。

约定：

- 去掉首尾空白，转小写；
- 连续空白折叠成单个 `-`；
- 移除除字母、数字、空白和 `-` 以外的字符（中文等 Unicode 字母保留）；
- 最后把连续 `-` 折叠成一个。

示例：`'  C++ 与 Node.js '` → `'c-与-nodejs'`。
