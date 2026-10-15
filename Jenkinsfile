pipeline {
    agent none

    options {
        timeout(time: 90, unit: 'MINUTES')
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        stage('Linux Node 22') {
            agent { label 'macmini' }
            environment {
                PATH = "/opt/homebrew/bin:${env.PATH}"
                DOCKER_HOST = 'unix:///Users/kimjinseong/.colima/omt-ci/docker.sock'
            }
            steps {
                checkout scm
                script {
                    try {
                        sh 'colima start --profile omt-ci --activate=false'
                        sh 'docker build -t inho-team-oh-my-teams-ci:node22 -f .ci/Dockerfile.linux .'
                        sh '''docker run --rm -e HOME=/tmp -v "$WORKSPACE:/workspace" -w /workspace inho-team-oh-my-teams-ci:node22 sh .ci/run-linux.sh'''
                    } finally {
                        sh '''
                            if docker info >/dev/null 2>&1; then
                                running=$(docker ps -q)
                                if [ -z "$running" ]; then
                                    colima stop --profile omt-ci
                                else
                                    echo "OMT CI Docker has running containers; preserve the profile."
                                fi
                            fi
                        '''
                    }
                }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }

        stage('macOS Node 22') {
            agent { label 'macmini' }
            environment {
                PATH = "/Users/kimjinseong/.nvm/versions/node/v22.23.2/bin:${env.PATH}"
                GIT_CONFIG_COUNT = "1"
                GIT_CONFIG_KEY_0 = "core.autocrlf"
                GIT_CONFIG_VALUE_0 = "false"
            }
            steps {
                checkout scm
                sh 'node --version && npm ci'
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run quality' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run format:check' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm test' }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }
    }
}
