# Testing External Behavior

这篇 practice 说的是测试边界。

测试不应该去控制内部实现。测试应该给系统一个外部用户能给的 context，然后从外部用户能看到的地方观察结果。

这个区别有点像 context / control。control 风格会倾向于说：为了测一个 case，我直接把内部状态改成我想要的样子。context 风格会倾向于说：真实用户能怎么把系统带到这个状态，我就在测试里怎么做。

context 风格更 solid，因为外部接口是稳定的。内部实现不是稳定的。表结构会变，service 会拆分，缓存会迁移，状态机也会换一种表达方式。只要外部行为没有变，这些变化都不应该让测试失败。

## Platform

在 platform 里面，外部用户的接口是页面。

所以测试应该通过页面交互来构造 case，也应该通过页面来验证结果。

比如：

1. 用户会点按钮，那么测试也点按钮。
2. 用户会在输入框里输入，那么测试也输入。
3. 用户能看到 toast、列表、URL、dialog，那么测试就断言这些东西。

不应该为了方便去 render 一个内部组件，不应该直接改 store，不应该直接调用 hook，也不应该断言 query cache、组件 state、CSS class、内部 callback 有没有被调用。

这些东西可能正好是今天的实现，但它们不是用户的接口。测试这些东西会把实现冻结住，最后 refactor 的时候测试失败，产品却没有坏。

## API

在 API 项目里面，外部用户的接口是 API endpoint。

所以 API 测试应该通过调用 API 来构造 case，也应该通过调用 API 来验证结果。

这意味着：

1. 构造数据时，优先调用生产环境里真实存在的 API。
2. 验证结果时，优先调用外部用户也能调用的 API。
3. auth、validation、serialization、idempotency、permission、no-existence-leak 都应该通过 endpoint 一起被测到。

对 API 来说，数据库不是外部接口。DB schema 是内部实现。

直接 insert / update / delete DB，是在告诉测试一个内部实现细节，而不是在描述用户行为。直接 select DB 做断言，也是在验证内部写法，而不是验证外部用户能看到的结果。

service 也不是外部接口。直接调用 service 构造 case，或者直接断言 service 返回值，绕过了 route、middleware、contract、auth 和 request parsing。这样的测试可能通过，但真实 API 仍然是坏的。

所以对于 API 项目来说，测试 DB 也好，操作 DB 也好，断言 DB 也好，操作 service 或断言 service 也好，都是在测内部实现。唯一可信的边界应该是 API endpoint。

## Exceptions

例外应该非常少。

只有当一个 case 在生产环境的外部接口里完全无法构造出来时，才可以离开外部行为边界。比如某些历史坏状态、某些只能由基础设施触发的状态，或者一个没有任何用户入口的内部 cron 状态。

下面这些不是例外：

1. 通过 API 构造比较麻烦。
2. 通过页面操作步骤比较多。
3. 现有 helper 已经能直接写 DB。
4. service 调起来更快。

如果一个状态可以通过真实 endpoint 或页面操作构造出来，就应该走那个路径。

当确实需要例外时，测试应该把例外写清楚：为什么生产外部接口无法构造这个状态，为什么这个 case 仍然值得测。不要把例外藏在通用 fixture 里，让后面的测试默认继承内部实现耦合。

## Lint

API 测试文件不应该 import DB schema，也不应该 import API service 文件。

这个 lint 不是为了让代码更整齐。它是在提醒测试作者：你正在跨过外部行为边界，开始控制内部实现。先回到 endpoint，看看能不能用真实 API 把 case 构造出来。
