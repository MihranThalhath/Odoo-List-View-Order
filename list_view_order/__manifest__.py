{
    "name": "List View Order",
    "summary": "Rearrange columns in list view userwise",
    "author": "Mihran Thalhath",
    "website": "https://www.mihranthalhath.com",
    "license": "OPL-1",
    "category": "Tools",
    "version": "17.0.1.0.0",
    "depends": ["web"],
    "data": [
        "security/res_group.xml",
        "security/ir.model.access.csv",
        "views/list_order.xml",
    ],
    "images": ["static/description/images/list_view_order.png"],
    "assets": {
        "web.assets_backend": [
            "list_view_order/static/src/views/view_dialogs/**.js",
            "list_view_order/static/src/views/view_dialogs/**.xml",
            "list_view_order/static/src/views/list/list_renderer.js",
            (
                "after",
                "web/static/src/views/list/list_renderer.xml",
                "list_view_order/static/src/views/list/list_renderer.xml",
            ),
        ],
    },
}
