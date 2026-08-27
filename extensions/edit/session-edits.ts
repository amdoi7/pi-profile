/**
 * 本 session 内被 edit 落盘过的文件。
 *
 * 为什么记：语料(2026-08-27,560 session)913 次 NOT_FOUND 里 638 次(69%)发生在
 * 本 session 自己已经改过的文件上——锚是改之前抄的。这个因不需要内容指纹、不需要
 * mtime、也不需要窥探别的工具：引擎知道自己写过什么。
 *
 * 只记 edit 自己的落盘。write/bash 的改写不进这里：它们的路径要靠猜 cwd 才能
 * canonical，猜错就会把「你改过」说成一句谎，而错的因比没有因更坏。
 */

const editedThisSession = new Set<string>();

/** 落盘成功后登记；入参必须是 canonical 绝对路径（pipeline 已解析）。 */
export function rememberEdited(canonicalPath: string): void {
	editedThisSession.add(canonicalPath);
}

export function wasEditedThisSession(canonicalPath: string): boolean {
	return editedThisSession.has(canonicalPath);
}

/** session 边界重置：跨 session 保留这份记忆就是在说谎。 */
export function forgetSessionEdits(): void {
	editedThisSession.clear();
}
