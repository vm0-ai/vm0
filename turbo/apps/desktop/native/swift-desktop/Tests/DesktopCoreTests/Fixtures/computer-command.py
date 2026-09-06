import json,sys
for line in sys.stdin:
    request=json.loads(line)
    kind=request['kind']
    if kind=='apps.list': result={'apps':[{'name':'Notes'}]}
    elif kind=='app.state':
        result={'app':'Notes','snapshotId':request['snapshotId'],'screenshot':'aW1hZ2U=','screenshotSource':'window','screenshotWidth':100,'screenshotHeight':100,'screenshotSourceBounds':{'x':0,'y':0,'width':100,'height':100},'windowId':1,'windowFrame':{'x':0,'y':0,'width':100,'height':100},'elements':[{'role':'AXButton','id':'opaque-button','index':0,'name':'Save','actions':['AXPress']}],'settled':request.get('settle',False)}
        result.update({'appDisplayName':'Notes','pid':1,'elementIdsByIndex':['opaque-button'],'nodeCount':1,'truncated':False,'truncationReasons':[],'screenshotMimeType':'image/png','screenshotSourceName':'Notes','windowIsOnScreen':True})
        if len(sys.argv)>1:
            field=sys.argv[1]
            if field=='app': result['app']='Unrelated app'
            elif field=='snapshotId': result['snapshotId']='unrelated-snapshot'
            else: del result[field]
    else:
        if 'elementIndex' in request:
            assert request['elementId']=='opaque-button'
            assert request.get('snapshotId')
        if kind=='element.click' and 'x' in request:
            assert request['screenshotSource']=='window'
            assert request['sourceBounds']['width']==100
        result={'received':request,'normalizedKey':request.get('key')}
    print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
