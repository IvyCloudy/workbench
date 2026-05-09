(function () {
    var vscode = acquireVsCodeApi();

    window.HttpClient = {
        postMessage: function (msg) {
            vscode.postMessage(msg);
        },
        query: function (params) {
            vscode.postMessage({
                command: 'query',
                currentPage: params.currentPage,
                pageSize: params.pageSize,
                testCaseNo: params.testCaseNo,
                testCaseName: params.testCaseName,
                testCasePath: params.testCasePath,
                testCasePriority: params.testCasePriority,
                testType: params.testType,
                type: params.type
            });
        }
    };
})();
